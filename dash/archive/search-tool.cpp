//
// search-tool.cpp
//
// MIT License
// Copyright (c) 2022-2024 Ken Kocienda. All rights reserved.
// 
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// 
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

#include <algorithm>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <regex>
#include <set>
#include <string>
#include <vector>

#include <getopt.h>
#include <stdio.h>

#include <UV/UV.h>

#define USE_FUTURES 0

#define USE_DISPATCH (UV_PLATFORM(MAC) && !USE_FUTURES)

#if USE_DISPATCH
#include <dispatch/dispatch.h>
#else
#include <future>
#include <semaphore>
// this semaphore limits the number of concurrent searches
const int good_concurrency_count = UV::get_good_concurrency_count() - 1;
std::counting_semaphore g_semaphore(good_concurrency_count);
#endif

extern int optind;

namespace fs = std::filesystem;

using UV::Allocator;
using UV::MappedFile;
using UV::Spread;
using UV::Size;
using UV::String;
using UV::StringView;
using UV::TextRef;

std::mutex g_lock;
std::vector<TextRef> g_text_refs;

enum class Skip { SkipNone, SkipSkippables };
enum class Mode { Search, SearchAndReplace, SearchAndReplaceDryRun };
enum class MatchType { All, Any };
enum class SearchCase { Sensitive, Insensitive };
enum class HighlightColor {
    None = 0,
    Black = 30,
    Gray = 90,
    Red = 91,
    Green = 92,
    Yellow = 93,
    Blue = 94,
    Magenta = 95,
    Cyan = 96,
    White = 97,
};
enum class MergeSpreads { No, Yes };
enum class LimitToSearchables { No, Yes };

class Env
{
public:
    Env(const fs::path &current_path,
        const std::vector<String> &string_needles,
        const std::vector<std::regex> &regex_needles,
        const String &replacement,
        TextRef::FilenameFormat filename_format,
        HighlightColor highlight_color,
        MatchType match_type,
        MergeSpreads merge_spreads,
        Mode mode,
        SearchCase search_case,
        Skip skip,
        LimitToSearchables limit_to_searchables) :
        m_current_path(current_path),
        m_string_needles(string_needles),
        m_regex_needles(regex_needles),
        m_replacement(replacement),
        m_filename_format(filename_format),
        m_highlight_color(highlight_color),
        m_match_type(match_type),
        m_merge_spreads(merge_spreads),
        m_mode(mode),
        m_search_case(search_case),
        m_skip(skip),
        m_limit_to_searchables(limit_to_searchables)
    {}

    const fs::path &current_path() const { return m_current_path; }
    const std::vector<String> &string_needles() const { return m_string_needles; }
    const std::vector<std::regex> &regex_needles() const { return m_regex_needles; }
    const String &replacement() const { return m_replacement; }
    TextRef::FilenameFormat filename_format() const { return m_filename_format; }
    HighlightColor highlight_color() const { return m_highlight_color; }
    MatchType match_type() const { return m_match_type; }
    MergeSpreads merge_spreads() const { return m_merge_spreads; }
    Mode mode() const { return m_mode; }
    SearchCase search_case() const { return m_search_case; }
    Skip skip() const { return m_skip; }
    LimitToSearchables limit_to_searchables() const { return m_limit_to_searchables; }

private:
    fs::path m_current_path;
    std::vector<String> m_string_needles;
    std::vector<std::regex> m_regex_needles;
    String m_replacement;
    TextRef::FilenameFormat m_filename_format;
    HighlightColor m_highlight_color;
    MatchType m_match_type;
    MergeSpreads m_merge_spreads;
    Mode m_mode;
    SearchCase m_search_case;
    Skip m_skip;
    LimitToSearchables m_limit_to_searchables;
};

static HighlightColor highlight_color_from_string(const String &s)
{
    std::map<String, HighlightColor> highlight_colors = {
        {"black", HighlightColor::Black},
        {"gray", HighlightColor::Gray},
        {"red", HighlightColor::Red},
        {"green", HighlightColor::Green},
        {"yellow", HighlightColor::Yellow},
        {"blue", HighlightColor::Blue},
        {"magenta", HighlightColor::Magenta},
        {"cyan", HighlightColor::Cyan},
        {"white", HighlightColor::White},
    };

    const auto r = highlight_colors.find(s);
    return r == highlight_colors.end() ? HighlightColor::None : r->second;
}

static std::vector<fs::path> build_file_list(const Env &env, const fs::path &dir)
{
    std::vector<fs::path> result;
    fs::directory_options options = fs::directory_options::skip_permission_denied;
    for (auto it = fs::recursive_directory_iterator(dir, options); it != fs::recursive_directory_iterator(); ++it) {
        const fs::directory_entry &dir_entry = *it;
        const fs::path &path = dir_entry.path();
        if (dir_entry.is_directory() && env.skip() == Skip::SkipSkippables && UV::is_skippable(UV::skippable_paths(), path)) {
            it.disable_recursion_pending();
            continue;
        }
        if (!dir_entry.is_regular_file()) {
            continue;
        }
        if (env.limit_to_searchables() == LimitToSearchables::No || UV::is_searchable(UV::searchable_paths(), path)) {
            result.push_back(path);
        }
    }
    return result;
}

class Match
{
public:
    Match() {}
    Match(Size needle_index, Size match_start_index, Size match_length) : 
        m_needle_index(needle_index), m_spread(match_start_index, match_start_index + match_length) {}

    Size needle_index() const { return m_needle_index; }
    void set_needle_index(Size needle_index) { m_needle_index = needle_index; }

    Size match_start_index() const { return m_spread.first(); }

    const Spread<Size> &spread() const { return m_spread; }
    void add_spread(const Spread<Size> &spread) { m_spread.add(spread); }
    void simplify_spread() { m_spread.simplify(); }

    Size line_start_index() const { return m_line_start_index; }
    void set_line_start_index(Size line_start_index) { m_line_start_index = line_start_index; }

    Size line_length() const { return m_line_length; }
    void set_line_length(Size line_length) { m_line_length = line_length; }

    Size line() const { return m_line; }
    void set_line(Size line) { m_line = line; }

    Size column() const { return match_start_index() - m_line_start_index; }

private:
    Size m_needle_index = 0;
    Spread<Size> m_spread;
    Size m_line_start_index = 0;
    Size m_line_length = 0;
    Size m_line = 0;
};

void process_file(const fs::path &filename, const Env &env)
{
#if !USE_DISPATCH
    // The guard releases the semaphore regardless of how the function exits
    UV::AcquireReleaseGuard semaphore_guard(g_semaphore);
#endif

    MappedFile mapped_file(filename);
    if (mapped_file.is_valid<false>()) {
        return;
    }

    StringView source((char *)mapped_file.base(), mapped_file.file_length());
    StringView haystack((char *)mapped_file.base(), mapped_file.file_length());
    
    String case_folded_string;
    if (env.search_case() == SearchCase::Insensitive) {
        case_folded_string = String(haystack);
        std::transform(case_folded_string.cbegin(), case_folded_string.cend(), case_folded_string.begin(), 
            [](unsigned char c) { return std::tolower(c); });
        haystack = case_folded_string;
    }

    std::vector<Match> matches;
    Size needle_index = 0;

    // do string searches
    for (const auto &string_needle : env.string_needles()) {
        const auto searcher = std::boyer_moore_searcher(string_needle.begin(), string_needle.end());
        auto hit = haystack.begin();
        while (true) {
            auto it = std::search(hit, haystack.end(), searcher);
            if (it == haystack.end()) {
                break;
            }
            matches.emplace_back(needle_index, it - haystack.begin(), string_needle.length());
            hit = ++it;
        }
        needle_index++;
    }

    // do regex searches
    for (const auto &regex_needle : env.regex_needles()) {
        const auto searcher_begin = std::cregex_iterator(haystack.begin(), haystack.end(), regex_needle);
        auto searcher_end = std::cregex_iterator();
        for (auto it = searcher_begin; it != searcher_end; ++it) {
            const auto &match = *it;                                                 
            matches.emplace_back(needle_index, match.position(), match.length());
        }   
        needle_index++;
    }

    // return if nothing found
    if (matches.size() == 0) {
        return;
    }

    // code below needs needles sorted by start index,
    // but only do the work if there is more than one needle
    Size needle_count = env.string_needles().size() + env.regex_needles().size();
    if (needle_count > 1) {
        std::sort(matches.begin(), matches.end(), [](const Match &a, const Match &b) { 
            return a.match_start_index() < b.match_start_index(); 
        });
    }

    // set line-related metadata for the match
    std::vector<Size> haystack_line_end_offsets = UV::find_line_end_offsets(haystack, matches.back().match_start_index());

    Size line = 0;
    for (auto &match : matches) {
        while (haystack_line_end_offsets[line] < match.match_start_index()) {
            line++;
            UV_ASSERT(line < haystack_line_end_offsets.size());
        }
        const auto &offsets = UV::offsets_for_line(haystack, haystack_line_end_offsets, line + 1);
        const Size sidx = offsets.first;
        const Size eidx = offsets.second;
        if (sidx != String::npos && eidx != String::npos) {
            match.set_line_start_index(sidx);
            match.set_line_length(eidx - sidx);
        }
        match.set_line(line + 1);
    }

    // if MatchType is All and there's more than one needle, 
    // filter each line's worth of matches to ensure each needle matches
    if (env.match_type() == MatchType::All && needle_count > 1) {
        std::vector<Match> filtered_matches;
        filtered_matches.reserve(matches.size());
        Size current_line = 0;
        std::set<Size> matched_needle_indexes;
        Size sidx = 0;
        Size idx = 0;
        for (const auto &match : matches) {
            if (current_line == 0) {
                current_line = match.line();    
            }
            if (current_line == match.line()) {
                matched_needle_indexes.insert(match.needle_index());
            }
            else {
                if (matched_needle_indexes.size() == needle_count) {
                    filtered_matches.insert(filtered_matches.end(), matches.begin() + sidx, matches.begin() + idx);
                }
                current_line = match.line();
                matched_needle_indexes.clear();
                matched_needle_indexes.insert(match.needle_index());
                sidx = idx;
            }
            idx++;
        }
        if (matched_needle_indexes.size() == needle_count) {
            filtered_matches.insert(filtered_matches.end(), matches.begin() + sidx, matches.begin() + idx);
        }
        matches = filtered_matches;
    }

    // return if all the matches got filtered out
    if (matches.size() == 0) {
        return;
    }

    // merge spreads if needed so each TextRef will contain all the matches for a line
    if (env.merge_spreads() == MergeSpreads::Yes) {
        std::vector<Match> filtered_matches;
        filtered_matches.reserve(matches.size());
        Size current_line = 0;
        for (auto &match : matches) {
            if (current_line == match.line()) {
                auto &back_match = filtered_matches.back();
                back_match.add_spread(match.spread());
            }
            else {
                current_line = match.line();
                filtered_matches.push_back(match);
            }
        }
        matches = filtered_matches;
        for (auto &match : matches) {
            match.simplify_spread();
        }
    }

    if (env.mode() == Mode::Search) {
        g_lock.lock();
        // add a TextRef for each match
        for (auto &match : matches) {
            String line = String(source.substr(match.line_start_index(), match.line_length()));
            Spread<Size> column_spread;
            for (const auto &match_stretch : match.spread().stretches()) {
                Size start_column = match_stretch.first() - match.line_start_index() + 1;
                Size end_column = match_stretch.last() - match.line_start_index() + 1;
                column_spread.add(start_column, end_column);
            }
            g_text_refs.emplace_back(0, filename, match.line(), column_spread, line);
        }
        g_lock.unlock();
        return;
    }

    UV_ASSERT(env.mode() == Mode::SearchAndReplace || env.mode() == Mode::SearchAndReplaceDryRun);

    // set up a string to hold the new string after the search and replace operation
    // estimate the size by adding the length of the replacement for each match
    String output;
    output.reserve(source.length() + (matches.size() * env.replacement().length()));
    Size source_index = 0;
    String output_line;

    g_lock.lock();
    for (auto &match : matches) {
        // set up the source line and spread for the replacement TextRef        
        StringView source_line = StringView(source.substr(match.line_start_index(), match.line_length()));
        output_line.clear();
        output_line.reserve(source_line.length() + (match.spread().stretches().size()) * env.replacement().length());
        Spread<Size> output_spread;
        Size output_line_index = 0;
        
        for (const auto &match_stretch : match.spread().stretches()) {
            // do the search and replace for the output file
            output += source.substr(source_index, match_stretch.first() - source_index);
            output += env.replacement();
            source_index += (match_stretch.first() - source_index);
            source_index += match_stretch.length();

            // do the search and replace for the TextRef       
            Size start_column = match_stretch.first() - match.line_start_index();
            output_line += source_line.substr(output_line_index, start_column - output_line_index);
            Size replacement_start_column = output_line.length() + 1;
            output_line += env.replacement();
            Size replacement_end_column = output_line.length() + 1;
            output_line_index += (start_column - output_line_index);
            output_line_index += match_stretch.length();
            output_spread.add(replacement_start_column, replacement_end_column);
        }
        // append any remaining text on the output line
        output_line += source_line.substr(output_line_index);

        // make the TextRef with the replaced text
        g_text_refs.emplace_back(0, filename, match.line(), output_spread, output_line);
    }
    g_lock.unlock();

    // append any remaining text on the output file
    output += source.substr(source_index);

    // write the changed file if needed
    if (env.mode() == Mode::SearchAndReplace) {
        UV::write_file(filename, output);
    }
}

static void output_refs(Env &env) 
{
    std::sort(g_text_refs.begin(), g_text_refs.end(), std::less<TextRef>());

    UV::String output(2 * 1024 * 1024);

    int count = 1;
    for (auto &ref : g_text_refs) {
        ref.set_index(count);
        count++;
        int flags = TextRef::HighlightMessage;
        if (env.merge_spreads() == MergeSpreads::Yes) {
            flags |= TextRef::CompactFeatures;
        }
        else {
            flags |= TextRef::ExtendedFeatures;
        }
        int highlight_color_value = static_cast<int>(env.highlight_color());
        ref.write_to_string(output, flags, env.filename_format(), env.current_path(), highlight_color_value);
        output += '\n';
    }
    std::cout << output;

    const char *refs_path = getenv("REFS_PATH");
    if (refs_path) {
        output.clear();
        std::ofstream file(refs_path);
        if (!file.fail()) {
            count = 1;
            for (auto &ref : g_text_refs) {
                ref.set_index(count);
                count++;
                ref.write_to_string(output, TextRef::StandardFeatures, TextRef::FilenameFormat::ABSOLUTE);
                output += '\n';
            }
            file << output;
        } 
    }

    UV::time_check_done(5);
    std::cout << "time: " << UV::time_check_elapsed_seconds(5) << std::endl;
    // std::cout << UV::Context::get().allocator().stats() << std::endl;
}

static void version(void)
{
    puts("search : version 4.1");
}

static void usage(void)
{
    version();
    puts("");
    puts("Usage: search [options] <search-string>...");
    puts("");
    puts("Options:");
    puts("    -a : Search all files in all directories not skipped (see -s option),");
    puts("             i.e., not just those listed in ENV['SEARCHABLES'].");
    puts("    -c <color>: Highlights results with the given color. Implies output to a terminal.");
    puts("                colors: black, gray, red, green, yellow, blue, magenta, cyan, white");
    puts(" ");
    puts("    -e : Search needles are compiles as regular expressions.");
    puts("    -h : Prints this help message.");
    puts("    -i : Case insensitive search.");
    puts("    -l : Show each found result on its own line.");
    puts("    -n : Search and replace dry run. Don't change any files. Ignored if not run with -r");
    puts("    -r : Search and replace. Takes two arguments: <search> <replacement>");
    puts("             <search> can be a string or a regex (when invoked with -e)");
    puts("             <replacement> is always treated as a string");
    puts("    -s : Search for files in all directories, including those in ENV['SKIPPABLES_PATH'].");
    puts("    -t : Print filenames in terse format (filename only; no preceding path).");
    puts("    -v : Prints the program version.");
    puts("    -y : Matches any needle given, rather than requiring a line to match all needles.");
}

static struct option long_options[] =
{
    {"all-files",         no_argument,       0, 'a'},
    {"highlight-color",   required_argument, 0, 'c'},
    {"regex-search",      no_argument,       0, 'e'},
    {"help",              no_argument,       0, 'h'},
    {"case-insensitive",  no_argument,       0, 'i'},
    {"long",              no_argument,       0, 'l'},
    {"dry-run",           no_argument,       0, 'n'},
    {"replace",           no_argument,       0, 'r'},
    {"search-skippables", no_argument,       0, 's'},
    {"terse",             no_argument,       0, 't'},
    {"version",           no_argument,       0, 'v'},
    {"any-needle",        no_argument,       0, 'y'},
    {0, 0, 0, 0}
};

int main(int argc, char **argv)
{
    UV::time_check_mark(5);

    UV_LOG_CHANNEL_ON(General);
    UV_LOG_CHANNEL_ON(Memory);

    bool option_a = false;
    bool option_e = false;
    bool option_i = false;
    bool option_l = false;
    bool option_n = false;
    bool option_r = false;
    bool option_s = false;
    bool option_t = false;
    bool option_y = false;

    String option_c;

    while (1) {
        int option_index = 0;
        int c = getopt_long(argc, argv, "ac:ehilnrstvy", long_options, &option_index);
        if (c == -1)
            break;
    
        switch (c) {
            case 'a':
                option_a = true;
                break;
            case 'c':
                option_c = String(optarg);
                break;
            case 'e':
                option_e = true;
                break;
            case 'h':
                usage();
                return 0;            
            case 'i':
                option_i = true;
                break;            
            case 'l':
                option_l = true;
                break;            
            case 'n':
                option_n = true;
                break;            
            case 'r':
                option_r = true;
                break;
            case 's':
                option_s = true;
                break;
            case 't':
                option_t = true;
                break;
            case 'v':
                version();
                return 0;            
            case 'y':
                option_y = true;
                break;
            case '?':
                version();
                return 0;            
            default:
                usage();
                exit(-1);
                break;
        }
    }

    if (optind >= argc) {
        usage();
        exit(-1);
    }
    
    std::vector<String> string_needles;
    std::vector<std::regex> regex_needles;
    std::regex::flag_type regex_flags = std::regex::egrep | std::regex::optimize;
    if (option_i) {
        regex_flags |= std::regex::icase;
    }

    int needle_count = option_r ? argc - 1 : argc;

    String replacement;
    if (option_r) {
        if (needle_count - optind != 1) {
            usage();
            puts("");
            puts("*** search and replace takes exactly two arguments");
            exit(-1);
        }
        replacement = argv[argc - 1];        
    }    

    for (int i = optind; i < needle_count; i++) {
        const char *arg = argv[i];
        if (option_e) {
            regex_needles.emplace_back(arg, regex_flags);
        }
        else {
            String needle(arg);
            if (option_i) {
                std::transform(needle.cbegin(), needle.cend(), needle.begin(), [](unsigned char c) { return std::tolower(c); });    
            }
            string_needles.push_back(needle);
        }
    }
    
    SearchCase search_case = option_i ? SearchCase::Insensitive : SearchCase::Sensitive;
    MatchType match_type = option_y ? MatchType::Any : MatchType::All;
    Mode mode = Mode::Search;
    if (option_r) {
        mode = Mode::SearchAndReplace;
        if (option_n) {
            mode = Mode::SearchAndReplaceDryRun;
        }
    }
    TextRef::FilenameFormat filename_format = TextRef::FilenameFormat::RELATIVE;
    if (option_t) {
        filename_format = TextRef::FilenameFormat::TERSE;
    }
    HighlightColor highlight_color = HighlightColor::None;
    MergeSpreads merge_spreads = option_l ? MergeSpreads::No : MergeSpreads::Yes;
    if (option_c.length() > 0) {
        highlight_color = highlight_color_from_string(option_c);
        if (highlight_color == HighlightColor::None) {
            usage();
            std::cout << "\n*** unsupported highlight color: " << option_c << std::endl;
            exit(-1);
        }
    }

    Skip skip = option_s ? Skip::SkipNone : Skip::SkipSkippables;
    LimitToSearchables limit_to_searchables = option_a ? LimitToSearchables::No : LimitToSearchables::Yes;

    __block Env env(fs::current_path(),
            string_needles,
            regex_needles,
            replacement,
            filename_format,
            highlight_color,
            match_type,
            merge_spreads,
            mode,
            search_case,
            skip,
            limit_to_searchables);

    fs::path current_path = fs::current_path();
    const auto &files = build_file_list(env, current_path);

#if USE_DISPATCH
    __block int completions = 0;

    for (const auto &filename : files) {
        dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_HIGH, 0), ^{
            process_file(filename, env);
            g_lock.lock();
            completions++;
            if (completions == files.size()) {
                output_refs(env);
                exit(0);
            }
            g_lock.unlock();
        });
    }

    dispatch_main();
#else
    std::vector<std::future<void>> futures;
    futures.reserve(files.size());
    for (const auto &filename : files) {
        auto a = std::async(std::launch::async, process_file, filename, env);
        futures.push_back(std::move(a));
    }

    // std::vector<TextRef> text_refs;
    // for (auto &f :futures) {
    //     std::vector<TextRef> file_refs = f.get();
    //     text_refs.insert(text_refs.cend(), file_refs.begin(), file_refs.end());
    // }

    output_refs(env);
#endif

    return 0;
}

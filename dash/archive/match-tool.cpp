//
// match-tool.cpp
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

#include <fstream>
#include <string>
#include <vector>

#include <getopt.h>

#include <UV/UV.h>

extern int optind;

namespace fs = std::filesystem;

using UV::ANSICode;
using UV::Size;
using UV::Spread;
using UV::String;
using UV::TextRef;

enum class IncludeDirectries { No, Yes };

static std::vector<fs::path> find_matches(const fs::path &dir, const std::vector<String> &needles, int flags, 
    IncludeDirectries include_directories = IncludeDirectries::No)
{
    std::vector<fs::path> result;
    fs::directory_options options = fs::directory_options::skip_permission_denied;
    for (auto it = fs::recursive_directory_iterator(dir, options); it != fs::recursive_directory_iterator(); ++it) {
        const fs::directory_entry &dir_entry = *it;
        const fs::path &path = dir_entry.path();
        bool is_directory = dir_entry.is_directory();
        if (is_directory && UV::is_skippable(UV::skippable_paths(), path)) {
            it.disable_recursion_pending();
            continue;
        }
        if (is_directory && include_directories == IncludeDirectries::Yes) {
            // keep going
        }
        else if (!dir_entry.is_regular_file()) {
            continue;
        }
        for (const auto &pattern : needles) {
            if (UV::filename_match(pattern, path, flags)) {
                result.push_back(path);
                break;
            }
        }
    }
    return result;
}

static void add_highlight(TextRef &ref, const String &match, const std::vector<String> &needles) 
{
    Spread<Size> spread;
    for (const auto &pattern : needles) {
        Size pos = 0;
        for (;;) {
            pos = match.find(pattern, pos);
            if (pos == String::npos || pos >= match.length()) {
                break;
            }
            spread.add(pos + 1, pos + pattern.size() + 1);
            pos++;
        }
    }
    if (spread.is_empty<false>()) {
        spread.simplify();
        ref.add_spread(spread);
    }
}

static void version(void)
{
    puts("match : version 4.1");
}

static void usage(void)
{
    version();
    puts("");
    puts("Usage: match [options] [pattern]...");
    puts("");
    puts("Options:");
    puts("    -a : Matches any needle given, rather than requiring a line to match all needles.");
    puts("    -c <color>: Highlights results with the given color. Implies output to a terminal.");
    puts("                colors: black, gray, red, green, yellow, blue, magenta, cyan, white");
    puts("    -d : Consider directories as potential matches.");
    puts("    -e : Matches must be exact.");
    puts("    -f : Prints full paths of matched files to stdout.");
    puts("    -h : Prints this help message.");
    puts("    -o : Opens matched files with progam name given, defaults to ENV['EDIT_OPENER'].");
    puts("    -p : Write filenames to stdout without numbers; good for piping results to other programs");
    puts("    -r : Writes numbered file references to ENV['REFS_PATH'].");
    puts("    -i : Case sensitive search.");
    puts("    -v : Prints the program version.");
    puts("    -1 : Stop at first match found.");
}

static struct option long_options[] =
{
    {"all-needles",      no_argument,       0, 'a'},
    {"highlight-color",  required_argument, 0, 'c'},
    {"directories",      no_argument,       0, 'd'},
    {"exact",            no_argument,       0, 'e'},
    {"full path",        no_argument,       0, 'f'},
    {"help",             no_argument,       0, 'h'},
    {"open",             optional_argument, 0, 'o'},
    {"pipe",             no_argument,       0, 'p'},
    {"refs",             no_argument,       0, 'r'},
    {"case-sensitive",   no_argument,       0, 's'},
    {"version",          no_argument,       0, 'v'},
    {"one match",        no_argument,       0, '1'},
    {0, 0, 0, 0}
};

int main(int argc, char *argv[])
{
    bool option_a = false;
    bool option_d = false;
    bool option_e = false;
    bool option_f = false;
    bool option_o = false;
    bool option_p = false;
    bool option_r = false;
    bool option_s = false;
    bool option_1 = false;

    String option_c;
    String opener;

    while (1) {
        int option_index = 0;
        int c = getopt_long(argc, argv, "ac:defho:prsv1", long_options, &option_index);
        if (c == -1)
            break;
        switch (c) {
            case 'a':
                option_a = true;
                break;
            case 'c':
                option_c = String(optarg);
                break;
            case 'd':
                option_d = true;
                break;
            case 'e':
                option_e = true;
                break;
            case 'f':
                option_f = true;
                break;
            case 'h':
                usage();
                return 0;            
            case 'o':
                option_o = true;
                if (argv[optind] != nullptr && optarg != nullptr && optarg[0] != '-') {
                    opener = String(optarg);
                }
                break;
            case 'p':
                option_p = true;
                break;
            case 'r':
                option_r = true;
                break;
            case 's':
                option_s = true;
                break;
            case 'v':
                version();
                return 0;            
            case '1':
                option_1 = true;
                break;            
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

    std::vector<fs::path> matches;
    std::vector<String> needles;
    std::vector<String> all_needles;

    fs::path cwd(fs::current_path());
    fs::path dir;
    fs::path prevdir;

    int filename_match_flags = 0;
    if (option_s) {
        filename_match_flags |= UV::FilenameMatchCaseSensitive;  
    }
    if (option_e) {
        filename_match_flags |= UV::FilenameMatchExact;  
    }

    IncludeDirectries include_directories = option_d ? IncludeDirectries::Yes : IncludeDirectries::No;

    int loop_end = option_a ? argc : optind + 1;

    for (int i = optind; i < loop_end; i++) {
        String str(argv[i]);
        if (str.length() == 0) {
            continue;
        }

        fs::path path = str.c_str();

        // determine directory
        if (path.is_absolute()) {
            dir = path;
        }
        else if (str.find_first_of('/') != String::npos) {
            dir = fs::relative(cwd, path);
        }
        else {
            dir = cwd;
        }
        needles.push_back(str);
        all_needles.push_back(str);

        // add to pattern list
        if (!prevdir.empty()) {
            prevdir = dir;
        }
        else if (dir != prevdir) {
            std::vector<fs::path> submatches(find_matches(dir, needles, filename_match_flags, include_directories));
            matches.insert(matches.end(), submatches.begin(), submatches.end());
            prevdir = dir;
            needles.clear();
        }
    }

    if (needles.size()) {
        std::vector<fs::path> submatches(find_matches(dir, needles, filename_match_flags, include_directories));
        matches.insert(matches.end(), submatches.begin(), submatches.end());
    }

    // search within previously found matches if needed
    if (!option_a) {
        for (int i = loop_end; i < argc; i++) {
            if (matches.size() == 0) {
                break;
            }
            String pattern = argv[i];
            all_needles.push_back(pattern);
            std::vector<fs::path> filtered_matches;
            for (const auto &match : matches) {
                if (UV::filename_match(pattern, match, filename_match_flags)) {
                    filtered_matches.push_back(match);
                }
            }
            matches = filtered_matches;
        }
    }

    // generate output
    std::stringstream file_out;
    int index = 0;
    int feature_flags = TextRef::Filename;
    int highlight_color = static_cast<int>(ANSICode::BrightColor::None);
    if (option_c.length()) {
        feature_flags |= TextRef::HighlightFilename;
        highlight_color = static_cast<int>(ANSICode::bright_color_from_string(option_c));
    }
    if (!option_p) {
        feature_flags |= TextRef::Index;
    }
    
    const String match_ending = option_p ? " " : "\n";
    for (const auto &match : matches) {
        index++;
        TextRef ref(index, match);

        file_out << ref.to_string(TextRef::Index | TextRef::Filename, TextRef::FilenameFormat::ABSOLUTE) << std::endl;
        if (option_f) {
            String string_match = fs::absolute(match);
            if (option_c.length()) {
                add_highlight(ref, string_match, all_needles);
            }
            std::cout << ref.to_string(feature_flags, TextRef::FilenameFormat::ABSOLUTE, cwd, highlight_color) << match_ending;
        }
        else {
            String string_match = fs::relative(match);
            if (option_c.length()) {
                add_highlight(ref, string_match, all_needles);
            }
            std::cout << ref.to_string(feature_flags, TextRef::FilenameFormat::RELATIVE, cwd, highlight_color) << match_ending;
        }
    }

    // write to file if needed
    if (option_r) {
        const char *refs_path = getenv("REFS_PATH");
        if (refs_path) {
            std::ofstream file(refs_path);
            if (!file.fail()) {
                file << file_out.str();
            } 
        }
    }

    // open matches if needed
    if (option_o && matches.size()) {
        if (opener.empty()) {
            opener = getenv("EDIT_OPENER");
        }
        std::vector<String> exec_args;
        if (opener == "code") {
            exec_args.push_back("-g");
        }
        for (const auto &match : matches) { 
            exec_args.push_back(match.c_str());
        }
        int rc = UV::launch(opener, exec_args);
        std::cerr << "*** match: exec error: " << strerror(errno) << ": " << opener << std::endl;
        return rc;
    }

    return 0;
}
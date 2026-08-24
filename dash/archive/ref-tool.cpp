//
// ref-tool.cpp
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

#include <format>
#include <fstream>
#include <iostream>
#include <filesystem>
#include <string>
#include <vector>

#include <getopt.h>

#include <UV/UV.h>

using UV::MappedFile;
using UV::Size;
using UV::Spread;
using UV::String;
using UV::StringView;
using UV::TextRef;
using UV::UInt32;

extern int optind;

static void version(void)
{
    puts("ref : version 4.1");
}

static void usage(void)
{
    version();
    puts("");
    puts("Usage: ref [options] [number]...");
    puts("");
    puts("Options:");
    puts("    -f : Reads refs from given file (default: ENV['REF_PATH']).");
    puts("    -h : Prints this help message.");
    puts("    -o : Opens refs with progam name given (default: ENV['EDIT_OPENER']).");
    puts("    -v : Prints the program version.");
}

static struct option long_options[] =
{
    {"file",    required_argument, 0, 'f'},
    {"help",    no_argument,       0, 'h'},
    {"open",    required_argument, 0, 'o'},
    {"version", no_argument,       0, 'v'},
    {0, 0, 0, 0}
};

int main(int argc, char *argv[])
{
    char *env_opener = getenv("EDIT_OPENER");
    String opener = env_opener ? env_opener : "";
    std::filesystem::path refs_path = getenv("REFS_PATH");

    while (1) {
        int option_index = 0;
        int c = getopt_long(argc, argv, "f:ho:v", long_options, &option_index);
        if (c == -1)
            break;
    
        switch (c) {
            case 'f':
                refs_path = std::filesystem::path(optarg);
                break;           
            case 'h':
                usage();
                return 0;            
            case 'o':
                opener = optarg;
                break;
            case 'v':
                version();
                return 0;            
            default:
                usage();
                exit(-1);
                break;
        }
    }

    if (refs_path.native().length() == 0) {
        refs_path = std::filesystem::absolute("~/.refs");    
    }

    if (optind >= argc) {
        if (!std::filesystem::exists(refs_path)) {
            std::cerr << "*** ref: unable to open refs file: " << refs_path << std::endl;
            exit(-1);
        }
        execlp("cat", "cat", refs_path.c_str(), NULL);
        exit(0);
    }


    if (opener.empty()) {
        std::cerr << "*** ref: no opener program specified" << std::endl;
        exit(-1);
    }

    MappedFile refs_file(refs_path);
    if (refs_file.is_valid<false>()) {
        std::cerr << "*** ref: unable to open refs file: " << refs_path << std::endl;
        return -1;
    }

    StringView refs_string_view((char *)refs_file.base(), refs_file.file_length());
    std::vector<Size> line_end_offsets = UV::find_line_end_offsets(refs_string_view);

    Spread<UInt32> spread;
    for (UInt32 i = optind; i < argc; i++) {
        String arg(argv[i]);
        spread.add(arg);
    }
    spread.simplify();

    if (spread.is_empty()) {
        return 0;
    }

    std::vector<String> exec_args;

    if (opener == "code") {
        exec_args.push_back("-g");
    }

    for (UInt32 sidx : spread) {
        if (sidx <= 0 || sidx > line_end_offsets.size()) {
            std::cerr << "*** no such ref: " << sidx << std::endl;
            return -1;
        }

        auto str = UV::String(UV::string_view_for_line(refs_string_view, line_end_offsets, sidx));
        UV::TextRef ref(UV::TextRef::from_string(str)); 
        std::cout << ref << std::endl;
        UV::String exec_arg = ref.to_string(TextRef::Filename | TextRef::Line |  TextRef::Column);
        exec_args.push_back(exec_arg);
    }

    if (exec_args.size() == 0) {
        std::cerr << "*** no refs" << std::endl;
        return -1;
    }

    int rc = UV::launch(opener, exec_args);
    std::cerr << "*** ref: exec error: " << strerror(errno) << std::endl;
    return rc;
}
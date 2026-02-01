#!/bin/bash

# find all the .sh files in subdirectories (not the current directory) and run them in their own directory
# this is a simple way to run all the test scripts

find . -name "test.sh" -execdir sh -c 'echo "Tooling test in $(pwd)"; bash {}' \;


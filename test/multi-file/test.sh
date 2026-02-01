#!/bin/bash

upp -w *.cup
cc *.c
./a.out
rm *.c *.h a.out

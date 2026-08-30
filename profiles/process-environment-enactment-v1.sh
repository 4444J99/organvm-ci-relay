#!/usr/bin/env bash
set -euo pipefail

cc -Wall -Wextra -pedantic -std=c99 \
  posix-envp-enactment.c -o posix-envp-enactment

./posix-envp-enactment seed-edge | tee posix-edge.txt
grep -Fx '000:some-other=values' posix-edge.txt
grep -Fx '001:NAME+some-other=value+values' posix-edge.txt
grep -Fx '002:=empty-name' posix-edge.txt
grep -Fx '003:noequals' posix-edge.txt
grep -Fx '004:name=value=with=equals' posix-edge.txt
grep -Fx '005:dup=one' posix-edge.txt
grep -Fx '006:dup=two' posix-edge.txt
grep -Fx '007:NAME=value' posix-edge.txt
if grep -F 'TAIL=x' posix-edge.txt; then exit 1; fi

./posix-envp-enactment seed-basic replicate | tee posix-replicate.txt
diff -u <(printf '000:third=3\n001:first=1\n002:second=2\n') \
  posix-replicate.txt

./posix-envp-enactment seed-basic append | tee posix-append.txt
diff -u \
  <(printf '000:third=3\n001:first=1\n002:second=2\n003:added=entry\n') \
  posix-append.txt

./posix-envp-enactment seed-basic omit | tee posix-omit.txt
diff -u <(printf '000:third=3\n001:second=2\n') posix-omit.txt

./posix-envp-enactment seed-basic replace | tee posix-replace.txt
diff -u \
  <(printf '000:third=3\n001:second=2\n002:first=replaced\n') \
  posix-replace.txt

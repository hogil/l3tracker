#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import re

def fix_indentation_errors():
    with open('api/main.py', 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    # 특정 라인들의 들여쓰기 수정
    fixes = {
        487: "        cached = DIRLIST_CACHE.get(key)\n",
        488: "        if cached is not None:\n", 
        489: "            return cached\n",
        516: "            DIRLIST_CACHE.set(key, items)\n",
        585: "            cached = THUMB_STAT_CACHE.get(key)\n",
        586: "            if cached:\n",
        587: "                return thumb\n",
        588: "            THUMB_STAT_CACHE.set(key, True)\n",
        589: "            return thumb\n",
        597: "                THUMB_STAT_CACHE.set(key, True)\n",
        598: "                return thumb\n"
    }
    
    for line_num, new_content in fixes.items():
        if line_num <= len(lines):
            lines[line_num - 1] = new_content
    
    with open('api/main.py', 'w', encoding='utf-8') as f:
        f.writelines(lines)
    
    print("Fixed all indentation errors")

if __name__ == "__main__":
    fix_indentation_errors()

---
name: listfiles
description: How to keep lists and tables of things in files (JSONL pattern).
---

# Best practice: How to keep lists and tables of things in files

If you need to keep track of multiple items (for example, subscribed chat groups, open tasks, emails having arrived today), **use JSONL files**.

* Each line is a JSON object representing one item. No linebreaks allowed in the JSON!
* Read with `fs_read`
* Add entries with `fs_append`
* Modify them with `fs_str_replace` replacing the line
* Search with `fs_grep`

**ALWAYS** append a closing linebreak `\n` when writing to the file, so that the next item can be appended as a new line.
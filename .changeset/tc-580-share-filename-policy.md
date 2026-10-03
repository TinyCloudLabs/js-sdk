---
"@tinycloud/share-sdk": patch
"@tinycloud/cli": patch
---

Share publication now applies the share viewer's filename policy: names are NFC-normalized, and control, format (such as U+200B zero-width space and U+202E bidi override), surrogate, and U+2028/U+2029 code points are refused before any content is read or uploaded. share-sdk exports `canonicalShareFilename` and `hasUnsafeFilenameCodePoint`, and `publishTargetShare` reports "filename contains control or invisible characters". `tc share publish` refuses every such filename with `UNSAFE_FILENAME` (exit 8), and addressed shares display the NFC-normalized name.

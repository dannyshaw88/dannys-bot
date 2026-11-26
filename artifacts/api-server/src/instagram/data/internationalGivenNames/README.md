# International Given Names — Filtered Edition

This directory contains a **modified data document**, derived from Jörg Michael's
`nam_dict.txt` (2007–2008), as redistributed by the gender-guesser project:

https://github.com/lead-ratings/gender-guesser/blob/820d86f9f652ef064e784998b516a8aa2abefe3c/gender_guesser/data/nam_dict.txt

Copyright (c) 2007–2008 Jörg Michael. The data and its modifications are licensed
under the GNU Free Documentation License, version 1.2 or any later version,
with no Invariant Sections, no Front-Cover Texts, and no Back-Cover Texts.
See `LICENSE.txt` and the preserved upstream notice in `SOURCE-NOTICE.txt`.
These terms apply to the derived data, not unrelated application code.

## Modification history

On 2026-11-26, the application maintainers produced this filtered edition:

- Normalised case and diacritics with the same rules used by the filter.
- Expanded `+` to the source's explicitly permitted joined spelling.
- Kept letter-only given names, without splitting compound entries into
  independently gender-labelled fragments.
- Combined labels across duplicate/normalised spellings.
- Accepted `F`/`1F` entries only when no `M`, `1M`, `?M` or `?` label conflicts.
- Kept male and ambiguous entries separately as exclusions.
- Omitted frequency/country columns and equivalence lines.

Existing application name rules and explicitly accepted examples are retained
separately. Dataset additions do not silently revoke those existing matches.
Name labels are historical statistical conventions, not verified identities.
The source covers many countries but is not comprehensive or current for every
language. The app makes no network requests for names during messaging.

## Reproduction

From the repository root, run:

```sh
node artifacts/api-server/scripts/importInternationalGivenNames.mjs
```

The generator pins the upstream revision, verifies minimum coverage, records a
source SHA-256, and includes the license and attribution with the JSON data.
No upstream executable code or Python dependency is bundled.

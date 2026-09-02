# Sample import files

## `example-library-import.xlsx` (committed)

A tiny, entirely synthetic workbook for testing the teacher portal's
**Import a Library** flow. Every title is a Neal Shusterman book, the dates are
placeholders, and there is no student data of any kind.

It deliberately contains the awkward cases the real exports have, so importing
it exercises the parser rather than just the happy path:

| Row | What it tests |
|---|---|
| 3× `Scythe`, 2× `Thunderhead` | one row per **copy** — must group into `copies`, not duplicate shelf entries |
| a `Scythe` row marked `Checked out` | status naming a student who doesn't exist in BookWare; must import as available |
| a `Thunderhead` row with no ISBN | the ISBN column is optional |
| a row with no title | must be skipped, not imported blank |
| `9.781442472037E12` | ISBN written as a **number**, so it arrives in scientific notation |

Parsing it should yield **2 books, 8 copies, 1 row skipped, 1 copy flagged as
checked-out in the file**.

## Real exports are NOT committed

`.gitignore` ignores every `*.xlsx` in the repo, with this one file as the sole
exception. That is deliberate.

A real export from a classroom-library app carries a **Checkouts** sheet listing
student names against the books they borrowed — an education record, and exactly
the data `retention.js` and `firestore.rules` exist to protect. This repository
is public. Do not commit one, even "just for testing", and do not remove the
ignore rule.

If you need a real library to test against, keep it out of git and strip the
names first. The convention is a `*.local.xlsx` suffix, which the ignore rule
already covers.

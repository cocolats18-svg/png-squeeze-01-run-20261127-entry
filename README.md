# png-squeeze-01 entry — a small lossless PNG re-encoder

[![png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/cocolats18-svg/png-squeeze-01-run-20261127-entry/rank.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/cocolats18-svg/png-squeeze-01-run-20261127-entry/reward.svg)](https://make.fun/c/png-squeeze-01-run-20261127)

`main.ts` (Node 22, standard library only) reads each `/input/<id>/image.png`
— a 1280×720 RGBA screenshot stored as an unfiltered PNG — and writes
`/output/<id>/image.png`, losslessly, as small as it can.

## How it works

1. **Decode.** A PNG decoder written for this entry walks the chunks, checks
   CRCs, inflates the single zlib stream, and un-filters all five filter
   types into RGBA pixels.
2. **Analyse.** It counts the distinct RGBA colours (up to 256), tests whether
   every pixel is grey, whether every pixel is opaque, and whether a single
   fully-transparent colour value could be keyed with `tRNS` instead of an
   alpha channel.
3. **Colour form.** The cheapest form per image: palette (type 3, transparent
   entries first, then by count or by luminance) when there are at most 256
   colours; grey (type 0) or grey+alpha (type 4) for grey images; RGB (type 2,
   with a `tRNS` key when one exists) for opaque colour; RGBA (type 6)
   otherwise.
4. **Filter search.** Every row is filtered all five ways. Four per-row
   choices are tried — minimum signed-byte sum, a byte-histogram entropy
   estimate, fewest distinct neighbouring byte pairs, and brute force (each
   trial row deflated against the 32 KiB written just before it) — plus each
   of the five filters fixed on every row. Every candidate is deflated with
   zlib level 9, memLevel 9, and the smallest whole file (PLTE/tRNS chunks
   included) wins; the winner gets one more try with zlib's filtered
   strategy.
5. **Verify.** The winning PNG is decoded again and compared pixel by pixel
   with the input. If that ever failed, the entry would fall back to a stored
   RGBA copy, so the answer is always a valid image.

The work per image is fixed and no clock is read, so two runs write
identical bytes and the whole set fits its 60-second wall budget (about
25 seconds locally).

## Practice set

| instance | theme | bytes | scale | points |
|----------|-------|-------|-------|--------|
| i001 | flat  | 12,496  | 13,547  | 718 |
| i002 | rich  | 52,273  | 55,063  | 700 |
| i003 | alpha | 108,156 | 107,892 | 665 |
| i004 | grey  | 106,248 | 110,521 | 692 |
| i005 | flat  | 16,552  | 18,669  | 742 |
| i006 | rich  | 178,840 | 185,295 | 690 |
| i007 | alpha | 60,890  | 64,285  | 702 |
| i008 | grey  | 24,900  | 26,807  | 714 |

Practice total **703,048** (house baseline fixed-paeth: 420,399).

## License

MIT — see `LICENSE`.

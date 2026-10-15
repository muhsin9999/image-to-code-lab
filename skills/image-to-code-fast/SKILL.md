---
name: image-to-code-fast
description: Reconstruct an editable responsive frontend from a website screenshot using measurements, visual corrections, a generated design brief and browser feedback. Supports varied layouts with explicit uncertainty about missing assets and inferred mobile behaviour.
---

# Screenshot to responsive page

## Prepare evidence and review

Run `npm run tool -- fast init --screenshot screenshot.png --out work --site site --max-minutes 10`. Add `--assets-dir assets` for supplied originals. Use `--language <code>` when appropriate OCR data is installed; otherwise record the limitation and recover wording through vision. Keep `--draft` off for agent trials.

When the harness supports a running command, inspect the screenshot while init runs. Use one vision reviewer: this is the current agent's visual stage, not an automatic remote-model call. Do not launch duplicate extraction. Read `work/design-brief.md` alongside the screenshot and `work/annotated.png`. Detailed section crops, facts.md, structure candidates and cached font metrics are available when needed.

Write a SHORT JSON plan using [the review contract](references/review-plan.md). Correct wording, element types, font classes, boundaries and component grouping. Describe relationships and responsive rules; coordinates are already in the evidence. Run `npm run tool -- fast review --out work --plan layout-plan.json`. The tool prepares reviewed assets/fonts and generates design-brief.md/json. Fix named validation errors and resubmit; accepted revisions remain in work/reviews/.

Use the generated brief AND the screenshot for coding. The provisional brief contains estimates; the reviewed brief contains agent judgments that still need render verification. Treat each page on its own evidence; there is no default website template.

## Build and render early

Advisory checkpoints: review around minute 2, first render by minute 5, completion around minute 10. These are test targets, not speed claims. Keep uncertainty explicit and render early instead of resolving every typography detail first.

Build site/src/App.tsx and styles with normal flow, flex/grid, shared widths, gaps and readable wrapping. All measured coordinates are PAGE-relative visible bounds, not nested CSS offsets. Absolute positioning belongs to intentional overlays inside positioned containers. Use semantic headings, controls and forms. Keep data-i2c-id on measured text where practical; corrected unread/icon IDs can identify text too.

Map each major reviewed component with `data-i2c-container="container-id"` (or an explicit selector in the plan). Record confident container bounds, columns, gaps, padding or aspect ratios as `constraints` in the review contract. These are reference-width measurements, not fixed pixel CSS rules for every device. Do not substitute unions of text ink boxes for actual container edges. The checker reports expected and rendered component geometry; keep uncertain measurements descriptive until reviewed.

Confirm serif/sans/mono for headings before fine sizing. Matching a string's width does not prove font identity. Checks never rewrite source font sizes or styles.

Use independent images for independent components. Prefer visually matched supplied originals. Batch clean crops through review. A photograph covered by live text needs an original, an already authorized asset provider, or an explicit placeholder. Never paint text out, reconstruct photographs with CSS/SVG, or enlarge small background fragments and claim the original composition. Use supplied icons or an icon library.

## Verify and repair

Run `npm run tool -- fast check --out work`. Each round builds, compares the reference viewport, checks reference/768px/390px and either side of up to four declared/discovered CSS breakpoints. It saves the main smaller-width screenshots. Extra widths belong to the same round; viewport-coverage.json identifies sampled/skipped boundaries.

Read check.md and inspect renders. Fix missing/covered content, shared container shifts and asset mistakes before small offsets. Treat measurement advice as hypotheses. Update review when evidence is wrong. Smaller layouts are inferred usability decisions. Declare task-required interactions in the review plan so checks assert their outcomes; typing alone does not verify subscription.

Repair in this order: missing content or broken controls/clipping; shared container widths/heights/columns; image composition; reviewed font class and wrapping; small decorative differences. A working responsive page must retain usable navigation. Disclosure controls need `aria-controls` and `aria-expanded`; the checker opens and closes visible controls. Declare additional outcomes for tabs, filtering and forms. Report local prototype state separately from real backend delivery.

Check details and each viewport result are saved incrementally. An incomplete check keeps its desktop evidence but cannot replace the best fully checked run. Resource timeouts are reported; they do not disable later tools. `fast timing` shows unfinished operations and recovers render timestamps from saved reports. An abrupt process kill may leave a start record without an end record.

Report whole-page pixel difference, component/browser issues, and asset completeness separately. Media and non-media comparisons use the same pixel threshold and a mask frozen on the first check. The non-media percentage is not a layout-quality score, and text over a missing background still needs visual inspection. Explicitly retire superseded image detections with `replaces`; only an unambiguous matching box is reconciled automatically.

Use fast status before repairs. Ten minutes and three total rounds are OBSERVATIONAL targets. All fast tools stay available afterwards; overruns and extra rounds are logged. Normally finish after two repairs. Continue for a concrete remaining defect worth extra time and record why. Checks before review are allowed but labelled provisional. If quality regresses, inspect the best result and use fast restore-best when preferable.

Finish with fast timing. Report first-render time, elapsed time, overruns, best visual difference, responsive issues, unresolved assets and interaction coverage. Untracked time includes reasoning, edits, unwrapped commands and waiting; do not call it known computation time.

## Extra measurements and commands

`fast metrics --out work` reuses cached batch font measurements. For changed strings pass `--jobs jobs.json`, an array of `{id,text,family,size,weight,targetWidth}`. One browser measures the batch; unchanged jobs are cached. These describe candidate fonts, not certain identities.

Run extra commands through `npm run tool -- fast exec --out work --job command.json`. The file contains `{"program":"node","args":["script.mjs"],"cwd":".","label":"operation name","reason":"why needed"}`. Use separate argument strings. The wrapper records timing, failures and overruns; nested calls are attributed without double-counting elapsed time. Commands outside it cannot be observed automatically.

Before writing another measurement script, record the missing operation and why existing tools cannot supply it in work/tool-gap.json. Reuse the checker for captures. Read detailed evidence only to resolve a concrete uncertainty.

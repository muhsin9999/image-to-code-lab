# Image to Code Lab

A screenshot-to-React toolkit. It measures visible text, shapes, colors and image regions, then helps a vision-capable coding agent review those measurements, build an editable page and compare browser renders. The current workflow is in [the fast skill](skills/image-to-code-fast/SKILL.md).

## What it does today

- `fast init` writes screenshot evidence, OCR results, font measurements and a provisional design brief.
- `fast review` accepts a short visual plan with corrected text, component relationships, responsive decisions and asset choices.
- `fast check` builds the React page, compares it with the screenshot, checks other widths and declared interactions, and saves its findings after each viewport.
- Time and round targets are advisory. Checks remain available after a target passes.

The [Fieldwork example](examples/fieldwork-dashboard/README.md) shows the latest completed result. Its desktop pixel difference was 4.06%; the first render took 8.9 minutes and the recorded trial lasted 34.9 minutes. This is a visual starting point, not a guarantee for any screenshot or a complete product interaction system. Read [current results](docs/RESULTS.md) and [next improvements](docs/NEXT.md).

## Requirements

- Node.js 22 or newer and npm.
- Google Chrome, or Playwright Chromium installed with `npx playwright install chromium`.
- Internet access for the first dependency installation. The English OCR data and font packages are included as npm dependencies.

On Windows, set `CHROME_PATH` to a Chrome executable if it is in a nonstandard location. The browser tools fall back to Playwright Chromium when that path is unavailable.

## Install and use

```sh
npm ci
npm run tool -- fast init --screenshot fixtures/fieldwork-reference/screenshot.png --out work --site site
```

Read `work/design-brief.md` and the screenshot. Write `layout-plan.json` using [the review schema](skills/image-to-code-fast/references/review-plan.md), then run:

```sh
npm run tool -- fast review --out work --plan layout-plan.json
# Build the page in site/src/App.tsx and site/src/style.css.
npm run tool -- fast check --out work
npm run tool -- fast timing --out work
```

Use `--assets-dir <folder>` with `fast init` when original images are available. The generated `work/` and `site/` folders are local outputs and are ignored by Git. `npm run tool -- help` lists commands. For a fresh isolated agent trial, run:

```sh
npm run pack -- fixtures/fieldwork-reference/screenshot.png ../new-image-to-code-trial
```

The packer copies the screenshot, current skill and toolkit into a new folder, then installs the React template from its lockfile. Give the agent that folder and ask it to follow `BRIEF.md` and `skill/SKILL.md`. The fixture's authoring HTML is not copied into an isolated trial.

## Verify

```sh
npm run responsive:regression
npm run brief:regression
npm run reliability:regression
npm run reviewed:smoke
```

These scripts create ignored output in `benchmarks/`. The full historical trials and generated reports are preserved locally in `archive/`, excluded from the public repository. The public example keeps the source, reference, renders and measured result without copied dependencies. Third-party npm packages and fonts retain their own licenses.

## Project layout

- `src/`, `bin/`: measurement, review, browser check and command-line code.
- `skills/image-to-code-fast/`: the coding-agent workflow and review contract.
- `templates/react-vite/`: editable React starter and lockfile.
- `fixtures/`: authored example reference.
- `examples/fieldwork-dashboard/`: reconstructed page and result.
- `docs/`: current status and next work.
- `scripts/`: packaging and current regression tests.
- `archive/`: local history, ignored by Git.

MIT licensed. See [LICENSE](LICENSE).

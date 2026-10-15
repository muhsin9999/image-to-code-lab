# Current baseline

The current toolkit is the v5 screenshot-to-React workflow in `bin/`, `src/`, `skills/image-to-code-fast/` and `templates/react-vite/`. It analyzes a screenshot, produces measured evidence, accepts an agent's visual review, creates an editable React page and checks renders at the reference and smaller widths.

The [Fieldwork dashboard example](../examples/fieldwork-dashboard/README.md) is the most recent complete agent trial. Its final desktop render differs from the authored reference in 4.06% of pixels at 1440 × 1380, using pixelmatch threshold 0.1. The first render took 8.9 minutes and the recorded run took 34.9 minutes with six checks. The bar chart was built in code; the map was extracted as a clean image crop. The mobile navigation drawer and workspace menu opened and closed in browser checks. Other visible controls do not have complete product behavior.

This result shows a usable visual starting point. It does not establish ten-minute completion or reliable fidelity across arbitrary sites. The complete local trial, logs, and previous experiments are retained under `archive/`, which is omitted from the public Git repository. Earlier Lourdon trials had much larger pixel differences, but they used a different screenshot and unavailable original photographs, so they are not a controlled comparison.

The regression scripts verify tool contracts and browser checks. They do not grade a new coding agent's output. Run the same model and settings on multiple unseen website types, then report the median and worst case for time, visual difference, missing content and interaction coverage.

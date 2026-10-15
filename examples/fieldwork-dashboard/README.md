# Fieldwork dashboard example

This is the result of an isolated screenshot reconstruction trial. The coding agent received [reference.png](reference.png), the toolkit, and a neutral brief. It did not receive the source of the reference page.

| Reference | Final desktop | Mobile adaptation |
|---|---|---|
| [Screenshot](reference.png) | [Render](result-desktop.png) | [390px render](result-mobile.png) |

The measured desktop pixel difference was **4.06%**. First render took **8.9 minutes**; the recorded run lasted **34.9 minutes** and used six checks. See [result.json](result.json) and [comparison.png](comparison.png). The result closely matches the dashboard's layout, color, table and map. Chart bars and some spacing differ. The bar chart is built in React/CSS; the map is a clean crop of the illustration in the screenshot.

At smaller widths, cards stack and a navigation drawer opens and closes. The tested drawer and workspace menus work. The rest of the product interactions, such as project creation, filtering and pagination, are visual placeholders. One screenshot does not define backend behavior.

To run this example:

~~~sh
cd app
npm ci
npm run dev
~~~

The complete trial evidence remains in the local archive and is excluded from the public package. This example demonstrates a starting visual workflow on one authored dashboard, not a guarantee across all website types.

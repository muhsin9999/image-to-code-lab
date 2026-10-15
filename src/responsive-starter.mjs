// No screenshot dimensions or page-family assumptions belong in the starter.
export const responsiveStarterCss = `* { box-sizing: border-box; }
html, body { margin: 0; }
body { -webkit-font-smoothing: antialiased; }
.page { width: 100%; min-height: 100svh; }
img, video, svg, canvas { max-width: 100%; }
img, video { height: auto; }
button, input, select, textarea { font: inherit; }
/* Build containers and components with normal flow, flex or grid.
   Reference coordinates are page measurements, never nested CSS offsets.
   Add page-specific breakpoints from the reviewed layout plan. */
`;

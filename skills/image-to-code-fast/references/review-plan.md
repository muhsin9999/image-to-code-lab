# Short visual review contract

```json
{
  "version": 1,
  "containers": [{
    "id": "content",
    "role": "Describe the actual component",
    "items": ["T1", "I1"],
    "layout": "Shared container, alignment, flow and gaps",
    "responsive": "Wrapping, stacking or intentional scrolling"
  }],
  "corrections": [],
  "additions": [],
  "assets": [],
  "uncertainties": [],
  "breakpoints": [],
  "interactions": []
}
```

Use actual measured IDs. Optional container parentId names another container; cycles are rejected. Include major regions and reading order. Write relationships, not a second coordinate inventory. The tool generates the complete brief.

## Measurable components

Use `data-i2c-container="content"` on that component, or set its `selector` explicitly. Optional `constraints` make visually reviewed decisions testable:

```json
{"id":"content","role":"Primary collection","items":["T1","I1"],"layout":"Two equal columns inside a centered container","responsive":"Stack when the available space is too narrow","constraints":{"bounds":[40,120,880,600],"columns":2,"gap":24,"padding":[24,24,24,24],"tolerance":6,"source":"visually-reviewed"}}
```

The numbers above illustrate the schema; measure the actual screenshot. Bounds are the component's border box `[pageX,pageY,width,height]`; padding is top/right/bottom/left; gap is the column gap; columns checks CSS grid tracks. Optional maxWidth and aspectRatio are supported. Default checks apply only at the reference width. `atWidths:[390]` limits an alternative constraint to listed widths. Each component currently accepts one constraint set; use declared interactions and inspect smaller renders for other responsive decisions. Keep responsive layout in normal flow; reference bounds do not instruct fixed positioning. Only supply values supported by the screenshot. Unmapped components generate warnings rather than fabricated measurements.

## Corrections

Each correction needs id and a visual reason. Supported fields:

- text: complete corrected wording. Also converts unread/icon items into text. Optional styleLike inherits a measured text style. Corrected text geometry becomes untrusted.
- type: text, image, icon, box, line, gradient or unread. Conversion to text requires wording.
- box: revised [x,y,width,height] inside the screenshot.
- family, size, weight, lineHeight, spacing, color, role: reviewed styling. Bundled font families are copied into the site. Other fonts require supplied files or an explicit fallback.
- replaces: IDs of fragments now represented by this corrected item (merge).
- ignore: true removes duplicate/junk detection, with a reason.
- geometryTrusted: false preserves uncertain geometry without forcing old measurements.
- required: false marks intentional optional content; never hide a real requirement.

## Missed or split items

Add entries to additions:
`{id:"newLabel",type:"text",box:[x,y,w,h],text:"Visible words",styleLike:"T5",replaces:["oldMergedId"],reason:"Separate component"}`.
New IDs must be unique. Multiple additions may replace one merged item. Optional sectionId selects a detected band; otherwise its containing band is inferred. Types match corrections. Use asset decisions for actual independent image files.

## Assets

Each asset needs a NEW id, reference-page box, reason and decision:

- crop: one complete unobstructed image. Known live-text overlap is rejected.
- reuse with sourceId: an available measured image or supplied original listed in evidence.
- placeholder: original unavailable.

Optional replaces retires incorrect/merged image IDs. Multiple crops may replace one merged image. Crops use the original screenshot. Replacing a text-covered full background with a small fragment enlarged to fill it is rejected: use an original, authorized generated asset or placeholder. New paths appear in design-brief.md/json. Raw facts remain unchanged.

An unambiguous old image box matching a single new asset within two pixels is retired automatically and recorded in asset-reconciliation.json. Other overlapping unresolved images produce replacement candidates for review. Overlap alone never retires a detection.

## Responsive checks and interactions

breakpoints optionally lists CSS widths from 240 to 3840. The checker samples either side of up to four declared/discovered breakpoints and reports skipped boundaries.

interactions declares local browser checks, for example:

```json
[{"selector":"#menu-button","action":"click","widths":[390,768],"expect":{"selector":"#mobile-menu","visible":true}},
 {"selector":"#email","action":"fill","value":"test@example.com","expect":{"value":"test@example.com"}}]
```

Actions: click, fill. Expectations: visible, text (contains), value, URL hash. Each starts with a fresh page load. Optional widths limits applicability. Specify required outcomes; clicking or filling alone does not verify commerce or subscription. Leave unsupported functionality unresolved.

Visible buttons with aria-controls and aria-expanded also receive an automatic open/close check against the controlled element. This verifies disclosure behavior only. Menus without a target are reported as unverified. Other controls still need declared expectations; a successful fill is not a successful submit.

Accepted plans are versioned. Resubmit the complete plan when changing an accepted review. The generated brief includes hierarchy, corrected content, bounds, typography, asset availability and uncertainties with evidence sources.

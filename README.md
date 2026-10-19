# Lumen — browser path tracer

A real-time, progressive **3D path tracer** that runs on the GPU in your browser (WebGL2).
Light is simulated physically: it bounces between surfaces, so you get soft shadows,
colour bleeding, reflections, refraction and caustics. The image starts noisy and
cleans up as samples accumulate.

## Run it

It's plain HTML + ES modules, no build step. Serve the folder with any static server:

```sh
npm start            # = npx http-server -c-1 .
# or
python3 -m http.server 8080
```

Then open http://localhost:8080. (Opening `index.html` straight from disk won't work,
because browsers block ES modules on `file://`.)

Needs a browser with WebGL2 and `EXT_color_buffer_float` (any recent Chrome, Edge, Firefox or Safari).

## Using it

| Action | How |
| --- | --- |
| Select | Click an object (or pick it from the Scene list) |
| Move on the floor plane | Drag an object |
| Raise / lower | <kbd>Shift</kbd> + drag an object |
| Orbit camera | Drag empty space |
| Pan | Right-drag (or <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + drag) |
| Zoom | Mouse wheel / pinch |
| Delete / duplicate | <kbd>Delete</kbd> / <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>D</kbd> |
| Focus depth of field on selection | <kbd>F</kbd> |

The side panel lets you add spheres, boxes, cylinders and lights, edit position,
rotation, size and material, and tweak the sky, sun, camera lens and quality
settings. Scenes auto-save to your browser and can be exported/imported as JSON.
"Save image" downloads the current render as PNG.

## What's simulated

- **Unidirectional path tracing** with next-event estimation (direct light sampling)
  and **multiple importance sampling**, Russian roulette, sub-pixel jitter for anti-aliasing.
- **Materials**
  - *Diffuse* — Lambertian.
  - *Plastic* — GGX microfacet clear coat over a diffuse base, with Fresnel.
  - *Metal* — GGX microfacet with Smith shadowing and Schlick Fresnel (colour = reflectance).
  - *Glass* — exact dielectric Fresnel, refraction by IOR, optional roughness (frosted),
    and Beer–Lambert absorption for tinted glass (thicker = darker).
  - Any object can *glow* (emission).
- **Lights**: spherical area lights (soft shadows that depend on size and distance)
  and a sun with adjustable angular size, plus a gradient sky.
- **Camera**: thin-lens depth of field, ACES filmic tone mapping, exposure.

## Code layout

| File | Purpose |
| --- | --- |
| `js/shaders.js` | GLSL path tracer + tone-mapping display shader |
| `js/renderer.js` | WebGL2 setup, scene upload, accumulation buffers |
| `js/scene.js` | Scene model, material presets, preset scenes, save/load |
| `js/main.js` | App state, mouse/touch/keyboard interaction, render loop |
| `js/ui.js` | Side panel (scene list, inspector, settings) |
| `js/picking.js` | CPU ray casting for clicking objects |
| `js/overlay.js` | Selection outline drawn over the render |
| `js/camera.js`, `js/math.js` | Orbit camera and vector helpers |

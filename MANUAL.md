# The Plexel manual

Plexel is an image editor for raster and vector work. It runs in the
browser and draws everything on your graphics card, so it needs a browser
with WebGPU: current Chrome, Edge, Safari or Firefox on a desktop computer.

This manual grows with the app. Each tool, panel, adjustment and filter gets
a section as it arrives, and tutorials follow once there is something to
make.

## 1. Getting around

### The window

- **The menu bar** runs along the top. Click a menu to open it; while one is
  open, moving the pointer along the bar opens the others. At its right end,
  the **workspace switcher** picks a set of panels for a kind of work
  (chapter 15).
- **The canvas** fills the middle. The grey around the image is the
  *pasteboard*. It stays a neutral grey in every theme, so the colours around
  your image never change how you judge the colours in it.
- **The options bar** runs across the window under the menu bar and shows
  the chosen tool's settings.
- **The toolbar** down the window's left edge, under the options bar, holds
  the tools. Click one, or press its key. Tools that share a key share a
  slot, as in Photoshop (the Pen, Curvature and Width tools; the Brush and
  Mixer Brush...): the slot shows the one you used last, with a small
  triangle in its corner. Right-click it, hold the button down or click
  the triangle for the others; Alt-click goes on to the next. When the
  window is too short for one column of tools, they go into two.
- **The docks** hold the panels: one on the right to start with, and one
  on the left once you put a panel there. Click a panel's title to fold it,
  × to close it, and drag a column's edge by the canvas to make it wider or
  narrower (double-click the edge for the standard width). Panels can be
  grouped as tabs, stacked, put in more columns or floated over the canvas:
  see "Arranging the panels" in chapter 15.
- **The status bar** along the bottom shows the front document's size,
  resolution and colour mode, its zoom and (when it's turned) rotation, and
  **Rendering…** while parts of the view are still being drawn. Then come
  the **key hints**: what each key does with the tool in use, right now
  (chapter 15). On the right it says whether the graphics engine is ready
  and which graphics adapter it is using.

Rest the pointer on a tool for its card: what it does, its key, and every
key and gesture it answers to. A greyed-out menu item says why it's greyed
out when you rest the pointer on it. Right-click the canvas for what can be
done there now (chapter 15).

### Commands

Every command is in the **command palette**: press **Ctrl+K** (⌘K on a Mac),
type a few letters of what you want, and press Enter. The letters only have
to appear in order, so `fs` finds Full Screen and `sdl` finds Switch Dark and
Light. Typing a category's name, such as `appearance` or `window`, lists
everything in it. ↑ and ↓ move through the list and Esc closes it.

The menus work from the keyboard too. Tab to a menu title and press ↓ to open
it, use the arrow keys to move (→ goes into a submenu or on to the next menu,
← comes back), Enter to choose, and Esc to close.

**Edit → Keyboard Shortcuts** (Ctrl+Alt+Shift+K, or Ctrl+/) lists every
shortcut, and changes them (chapter 15). The keys below are Plexel's own.

| Shortcut | What it does |
| --- | --- |
| Ctrl+Alt+N | New document |
| Ctrl+O | Open a document or an image |
| Ctrl+S | Save |
| Ctrl+Shift+S | Save As |
| Ctrl+Alt+W | Close the document in front |
| Ctrl+Alt+Shift+W | Export as PNG, JPEG, WebP, PSD, PSB, SVG, PDF or EPS |
| Ctrl+Alt+Shift+S | Save for Web: compare formats and sizes side by side |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+X, Ctrl+C, Ctrl+V | Cut, copy and paste (chapter 13) |
| Ctrl+Shift+V | Paste in Place |
| Ctrl+Alt+Shift+V | Paste Into the selection |
| Ctrl+Alt+Shift+C | Copy Merged |
| Ctrl+J | Layer via Copy; with nothing selected, Duplicate Layer |
| Ctrl+Alt+C | Canvas Size |
| F2 | Rename the selected layer |
| Ctrl+, | Show or hide the selected layer |
| Ctrl+] and Ctrl+[ | Move the selected layer up or down |
| Delete or Backspace | Clear what's selected; with nothing selected, delete the selected layer (or, with an alpha or spot channel picked, clear the channel) |
| Ctrl+Alt+Shift+N | New pixel layer |
| Alt+Backspace | Fill the selected layer (or what's selected of it) with the foreground colour |
| Ctrl+Backspace | Fill it with the background colour |
| Ctrl+A, Ctrl+D | Select all, deselect |
| Ctrl+Shift+D | Reselect |
| Shift+F7 | Inverse |
| Shift+F6 | Feather the selection |
| Ctrl+Alt+R | Select and Mask |
| Q | Quick Mask on and off |
| Ctrl+2, Ctrl+3… | Pick the composite channel, then each channel after it (chapter 20) |
| Ctrl+Alt+2 | Load the luminosity as the selection |
| Ctrl+Alt+T | Free Transform |
| Enter and Esc | Commit or cancel a Free Transform, a crop or a Polygonal Lasso |
| ← → ↑ ↓ | Nudge the selected layer a pixel (with a selection tool, the selection); Shift for ten |
| Ctrl+Alt+G | Clip the selected layer to the one below, or release it |
| X | Swap the foreground and background colours |
| D | Black foreground, white background |
| Ctrl+Shift+K | Colour Settings |
| Ctrl+Y, Ctrl+Shift+Y | Proof Colours, Gamut Warning |
| Ctrl+0 | Fit on Screen |
| Ctrl+1 | 100% |
| Ctrl+= and Ctrl+− | Zoom in and out a step |
| V, M, L, W, C | The Move tool, Marquee, Lasso, Magic Wand and Crop |
| P, A, U, T | The Pen, Direct Selection, the Shape tool and the Type tool |
| B, E, I | The Brush, Eraser and Colour Picker |
| H, Z, R | The Hand, Zoom and Rotate View tools |
| [ and ] | A smaller or larger brush |
| Space (held) | The Hand, whatever tool is chosen |
| A tool's key, held | That tool until you let go, then the one before (chapter 15) |
| Alt and a right-drag | Size (left and right) and hardness (up and down) of the brush, on the canvas |
| Tab, Shift+Tab | Hide or show the panels and bars; the dock alone |
| F | The next screen mode |
| Ctrl+K | Opens the command palette |
| Ctrl+Alt+Shift+K, Ctrl+/ | Lists and changes the keyboard shortcuts |
| Ctrl+Shift+L | Switches between dark and light |

New, Close and Free Transform use Ctrl+Alt because the browser keeps Ctrl+N,
Ctrl+W and Ctrl+T for itself. Inverse is Shift+F7, Photoshop's other key for
it, because Ctrl+Shift+I opens the browser's developer tools. For the same
reason Copy Merged is Ctrl+Alt+Shift+C rather than Photoshop's Ctrl+Shift+C
(the browser's inspector), and Layer via Cut has no key (Ctrl+Shift+J is
the browser's console).

Keys and the mouse belong to Plexel, not the browser: Ctrl+F, Ctrl+P,
Ctrl+R and F5, Ctrl+wheel and pinching, the right button, the middle
button and the back and forward buttons do nothing the browser would do
with them, so a slip doesn't print, zoom the page or leave it. Text fields
still type, edit and use the clipboard as usual (and keep their own
right-click menu), Tab still moves between controls when one has the
focus (on the canvas it hides the panels), and F12 still opens
the developer tools. Ctrl+W, Ctrl+T, Ctrl+N and Ctrl+Tab are the browser's
before any page hears of them, except in full screen (View → Browser Full Screen)
in Chrome or Edge, where Plexel takes those keys too; there, hold Esc to
leave full screen.

### Panels

| Panel | What it shows |
| --- | --- |
| Properties | The selected layer's settings (an adjustment's or a filter's too), or the document's when no layer is selected. |
| Colour | The foreground and background colours, in RGB, HSB, Lab, CMYK or Gray. |
| Swatches | Colours kept for reuse. |
| Brushes | Brush presets, each with a stroke drawn by it. |
| Layers | The layers of the document in front, top first. |
| History | Every change to the document in front, by name. |

The **Window** menu shows and hides each panel (a panel behind another's
tab is brought to the front rather than closed), and **Window → Workspace**
picks a set of panels for a kind of work (chapter 15). Where the panels are,
which are folded and how big they are is remembered by your browser.

### Appearance

**View → Theme** picks one of three themes, each in a dark and a light mode:

- **Graphite**: neutral greys with a blue accent. The default.
- **Darkroom**: warm greys with a safelight amber.
- **Fjord**: cool slate with a sea teal.

The choice is remembered by your browser.

### When something is wrong

- **"Plexel needs WebGPU"** means the browser has no WebGPU, or offered no
  graphics adapter for it. Updating the browser and the graphics driver
  usually fixes it. In Chrome or Edge, `chrome://gpu` shows why WebGPU is
  unavailable.
- **Help → Graphics Information** shows what the engine knows about your
  graphics adapter. If you report a problem, include what it says.
- If the graphics device is lost (a driver update or reset can do this), the
  canvas says so and Plexel gets a new one. If that keeps failing, it asks
  you to reload.

## 2. Documents

### Making one

**File → New** (Ctrl+Alt+N), or **New Document** on the start screen.

| Setting | What it does |
| --- | --- |
| Preset | Fills in everything below for a common size: Full HD, 4K, A4, US Letter, a photo print and more. Changing any field by hand makes it Custom. |
| Name | The document's own name. It's also what the file is called the first time you save. |
| Width, Height | The canvas size, in the chosen units. Up to 300,000 pixels a side. |
| Units | Pixels, inches, centimetres, millimetres or points. Changing the unit converts what's typed. |
| Resolution | Pixels per inch. It decides how big the document prints, and turns inches and millimetres into pixels. |
| Colour mode | RGB for screens, CMYK for print, Gray for black and white. |
| Background contents | What the document starts with: a Background layer of white, black or the background colour, or nothing (transparent). |
| Bit depth | 8 or 16 bits per channel. 16 bits keeps smooth gradients smooth through heavy edits, at twice the memory. |
| Colour profile | The colour space the numbers mean. The list depends on the mode. |

The line under the fields shows the size the document will have, in pixels.

Each open document has a **tab** above the canvas. A dot on the tab means it
has changes that aren't saved to its file. Click a tab to bring it to the
front; click its × or middle-click it to close it.

### Saving and opening

Documents are saved as **.pxll** files. A .pxll is an ordinary zip file, so
if something ever goes wrong, any unzip tool can look inside one.

- **File → Save** (Ctrl+S) saves to the document's file. The first time, it
  asks where.
- **File → Save As** (Ctrl+Shift+S) saves to a new file, which the document
  then belongs to.
- **File → Open** (Ctrl+O) opens a .pxll, or an image (see *Images*). You
  can also drop either onto the window. Opening a file that's already open
  brings its tab to the front.
- **File → Open Recent** and the start screen list the files you've opened
  and saved.

In Chrome and Edge, Save writes straight back to the file, as a desktop app
does. The browser may ask the first time whether Plexel may edit the file.
In other browsers, Save downloads a copy, and Open Recent isn't available.

If a file is damaged, or was saved by a newer version of Plexel, it isn't
opened, and a message says why. If a file had problems that could be
repaired, it opens, and a message lists what was repaired.

Big documents save and open without waiting on all their pixels at once. A
save writes the file as it goes, a layer at a time. A file over 64 MB opens
straight away and reads each part of the image from the file the first time
it's shown, so the first view of a huge image comes up quickly. A saved
.pxll also holds a small picture of the document, for file browsers and
other tools.

### Autosave

You don't need to save to keep your work while you edit. Every open
document is kept in your browser's own storage as you change it. If you
close the tab, the browser crashes, or the power goes, the next time you
open Plexel everything that was open is open again, unsaved changes
included, and Save still saves to each document's own file.

That storage belongs to the browser, not to a file you can see, so Save is
still how you keep a document for good, move it or send it to someone. If
the browser's storage is full or missing, the status bar says **Not
autosaving**, and leaving the page asks first.

Closing a document that has unsaved changes asks whether to **Save** them,
**Don't Save** (they're lost) or **Cancel**.

### Undo and History

**Edit → Undo** (Ctrl+Z) takes back the last change and **Edit → Redo**
(Ctrl+Shift+Z) brings it back. The menu says which change each
one is: "Undo Canvas Size". Each document keeps its last hundred changes.

The **History** panel (Window → History) lists every change by name. Click
one to go straight back, or forward, to it. Changes after the one you're on
stay listed, dimmed, until you make a new change.

Dragging a slider is one change, however far you drag it.

### Layers

The **Layers** panel lists the document's layers, the top one first.

- Click a layer to select it. Its settings appear in the Properties panel.
- The eye at the left shows or hides it (Ctrl+,). **Alt-click** an eye to
  show that layer alone, hiding the rest; Alt-click it again and they come
  back as they were. Either is one step in the history.
- Rest the pointer on a row for its **quick actions** at the right: the
  lock (locks or unlocks the layer), duplicate and delete. A locked layer
  shows its lock all the time.
- Rest the pointer on a thumbnail to see it **larger**, beside the panel.
- The arrow folds a group's layers away. Folding isn't a change to the
  document, so it isn't in the history.
- Double-click a name, or press F2, to rename it. Enter keeps the new name;
  Esc puts the old one back.
- The **buttons along the panel's foot**, from the left: a new adjustment
  layer (a menu of them opens above the button), a new pixel layer,
  duplicate the selected layers, and delete them. Rest the pointer on one
  for its name.
- **Layer → New Group** adds an empty group above the selected layer.
- **Layer → Duplicate Layer** copies it, just above itself (chapter 13).
- **Delete** (the button, or the Delete key) removes the selected layers
  and everything in them. The layer below is selected next (the one above
  if there's none below), so pressing Delete again removes that one; Undo
  taking away the selected layer does the same.
- **Layer → Move Layer Up** (Ctrl+]) and **Move Layer Down** (Ctrl+[) move it
  within its group.
- **Drag a layer** to move it anywhere. Drop it on the top or bottom edge of
  another layer to put it above or below that one; drop it on the middle of
  a layer to put it inside. A line, or an outline round the row, shows where
  it will go, and a label beside the pointer says it in words: "Below
  Background", "Into Group 1", "Clipped to Layer 2", or "Can't go here".

Putting a layer inside a group groups it. Putting it inside any other layer
**clips** it: it only shows where that layer does, as Photoshop's clipping
masks do. Drag it out again to unclip it.

Each pixel layer and group has a **thumbnail**: the layer on its own, over
the checkerboard where it's transparent. A layer with a mask shows the
mask's thumbnail beside it (chapter 6), and a layer clipped to the one
below it has a hook (↳) before its thumbnail. A layer's live filters are
listed under it (chapter 7), and "fx" marks a layer with a layer style.

The **Properties** panel shows the selected layer's settings:

| Setting | What it does |
| --- | --- |
| Opacity | How much the layer shows, from 0 to 100%. |
| Fill | How much the layer's own content shows. The same as Opacity until layers have effects (a later version), which Fill leaves at full strength. |
| Blend mode | How the layer mixes with what's under it. All of Photoshop's modes, in Photoshop's groups. Pass Through is for groups only and is a new group's default: the group's layers blend as if they weren't in a group. Any other mode makes the group *isolated*: its layers are combined first, and the result blends with what's below. |
| Resampling | Pixel layers: how the layer is redrawn when it's moved by a fraction of a pixel, scaled or turned. Nearest Neighbour keeps hard pixel edges; Bilinear is soft; Bicubic is smooth and the default; Lanczos is the sharpest. |
| Knockout | Groups: whether the group's layers cut through what's under them. Shallow cuts through to the layers below the group; Deep cuts through to the bottom layer of the document. A layer in a knockout group at 0% fill shows a clean hole. |
| Visible | Shows or hides the layer. |
| Locked | Locks the layer: it can't be painted, filled, moved or transformed. |
| Lock position | The layer can still be painted, but not moved or transformed. |

With no layer selected, it shows the document: its size, print size,
resolution, colour mode and profile.

### Canvas Size and Resolution

**Document → Canvas Size** (Ctrl+Alt+C) makes the canvas bigger or smaller.
The **anchor** says which part stays put: the middle, a corner or an edge.
Layers keep their place against the anchor, and nothing outside the new
canvas is deleted, so making the canvas big again brings it all back.

**Document → Resolution** changes how many pixels make an inch. The pixels
themselves don't change, only how big the document prints.

**Document → Rename Document** changes the document's name. Its file keeps
its own name until you Save As.

### Images

Plexel opens and imports PNG, JPEG, WebP and TIFF images, and exports PNG,
JPEG and WebP. Photoshop documents, SVG and PDF are in chapter 11.

- **File → Open** (Ctrl+O), or dropping an image anywhere but on an open
  document's canvas, opens it as a **new document**, with the image's own
  size, colour mode, bit depth and colour profile: a 16-bit PNG stays 16-bit
  and a CMYK TIFF stays CMYK. An image with no profile is taken to be sRGB
  (or Gray Gamma 2.2). The document isn't tied to the image file: saving it
  makes a .pxll.
- **File → Import as Layer**, or dropping an image on an open document's
  canvas, adds it as a **new layer** above the selected one, named after the
  file. It's converted into the document's colour mode, bit depth and
  profile, with the rendering intent in Colour Settings. A dropped image
  lands where you dropped it; an imported one in the middle. One Undo takes
  it away.
- **File → Export** (Ctrl+Alt+Shift+W) saves the document flattened, every
  visible layer combined, as a PNG, a JPEG or a WebP, or with its layers as a
  Photoshop document, an SVG or a PDF (chapter 11). The dialog says what
  the file will hold before you save it.

| Format | Opens | Exports |
| --- | --- | --- |
| PNG | Every kind: 1 to 16 bits, gray, colour, palette, transparency, interlaced, with its profile | 8 or 16 bits as the document is, with transparency and the profile. A CMYK document is converted to sRGB, since PNG has no CMYK. |
| JPEG | RGB, gray and CMYK (Photoshop's too), baseline and progressive, with the profile | 8-bit RGB on white (JPEG has no transparency) at the quality you choose, with the profile; Gray and CMYK documents are converted to sRGB |
| WebP | Lossy and lossless, with transparency and the profile (as Chrome decodes it, 8-bit RGB) | 8-bit RGB with transparency, lossy at the quality you choose or **Lossless** (every pixel exact), with the profile; Gray and CMYK documents are converted to sRGB. Small files for the web, so there's nothing to convert afterwards. |
| TIFF | 1 to 16 bits, gray, RGB, palette and CMYK, with transparency and the profile; uncompressed, LZW, ZIP or PackBits, in strips or tiles. Not yet: JPEG-compressed TIFFs, floating point, and Photoshop's layers inside TIFFs (the flattened image opens) | Later |

### Save for Web

**File → Save for Web** (Ctrl+Alt+Shift+S) is Photoshop's Save for Web
(Legacy): it shows the image as it will be on the web, in the formats
you're choosing between, with each file's size and how long it takes to
download.

- **Original** shows the image as it is; **Optimized** the file being set;
  **2-Up** the two side by side; **4-Up** the original and three files to
  compare, each with its own settings: click one to set it (it's
  outlined). Drag any of them to look round; they move together. The zoom
  is at the top right.
- **Format**: **JPEG** (a quality, on a matte colour since it has no
  transparency), **PNG-24** (every colour, transparency or a matte),
  **PNG-8** (a palette of 2 to 256 colours, dithered or not, with one-bit
  transparency, often the smallest for flat graphics), or **WebP** (a
  quality, or lossless, with transparency).
- **Image size** makes the file smaller or larger than the document, by
  width, height or a percentage, in proportion if you keep it ticked; the
  document isn't changed.
- **Convert to sRGB** (on, as the web expects) converts the colours; off,
  an RGB document keeps its own profile. **Embed colour profile** puts the
  profile in the file.

**Save** writes the chosen file. Save for Web remembers its layout and
settings for next time.

## 3. Colour

### Foreground and background

Plexel keeps two colours, as every image editor does: the **foreground**,
which fills and (later) painting use, and the **background**. The
**Colour** panel shows them as two overlapping squares, the foreground in
front.

- Click a square to edit that colour with the sliders.
- ⇄ (or **X**) swaps them.
- The small black-and-white pair (or **D**) puts them back to black on
  white.

### Colour chips

Everywhere else a colour is set (a shape's fill, a gradient's stops, a
filter's colour, a swatch, an ink, the guides), it shows as a **colour
chip**. Click it for the colour picker:

- Drag in the square for saturation and brightness, and along the strip
  under it for the hue.
- Or use the sliders and numbers, in the same models as the Colour panel,
  or type a hex code.
- The chips along the bottom take the foreground, the background, one of
  the document's swatches or one of yours.
- A colour the document can't print is warned of, as in the Colour panel.

The colour changes as you go, and everything you do in the picker is one
step to undo. Esc, Enter or a click outside closes it.

### Colour models

The buttons across the top of the panel choose how the colour is shown:

| Model | Channels |
| --- | --- |
| RGB | Red, green and blue, 0 to 255. The # field takes a hex colour such as 3a66db. |
| HSB | Hue in degrees, saturation and brightness in percent. |
| Lab | Lightness 0 to 100, and a and b, the green–red and blue–yellow axes. |
| CMYK | Cyan, magenta, yellow and black ink, in percent. |
| Gray | Black ink, in percent. |

Each slider's track shows what the colour would become along it.

A colour keeps the model and profile it was picked in. In a document of
the same mode, the sliders use the document's own profile, so RGB numbers
in an Adobe RGB document are Adobe RGB numbers. Otherwise they use sRGB,
Generic CMYK or Gray Gamma 2.2.

### Out of gamut

Not every colour can be shown on every device or printed by every ink. When
the colour you're editing can't be reproduced in the front document's
colour space, the panel says **Outside this document's gamut**. Click the
warning to change the colour to the nearest one the document can hold. If
you fill with an out-of-gamut colour anyway, the nearest colour is used and
a message says so.

### Filling a layer

**Edit → Fill with Foreground** (Alt+Backspace) and **Fill with Background**
(Ctrl+Backspace) fill the selected pixel layer with that colour, converted
into the document's colour space: the whole canvas, or with a selection,
what's selected (chapter 6). **Layer → New Pixel
Layer** (Ctrl+Alt+Shift+N) adds an empty one to fill. **Edit → Fill**
(Shift+F5) has the other contents and the blending (chapter 14).

### Profiles

A document's **colour profile** says what its numbers mean: which red
"255, 0, 0" is, or what a mix of inks looks like printed. Plexel has
these built in:

| Profile | For |
| --- | --- |
| sRGB IEC61966-2.1 | Screens and the web. The safe default. |
| Display P3 | Wide-gamut screens: most recent Macs, phones and many laptops. |
| Adobe RGB (1998) compatible | Photography and print work that needs more greens and cyans than sRGB. |
| ProPhoto RGB compatible | Very wide-gamut photo editing. Use 16 bits with it. |
| Rec. ITU-R BT.2020 | Video and HDR mastering. |
| Gray Gamma 2.2, 1.8 | Black-and-white images. |
| Generic CMYK (Plexel) | Working in CMYK when you don't yet have your printer's profile. It's a plausible model of ink on paper, not a measured press. For print, load the profile your printer gives you. |

**Document → Assign Profile** changes the profile a document's numbers are
read in. The numbers don't change, so the colours look different: use it
when a document was made in the wrong profile. **Load Profile…** reads an
ICC profile file (.icc or .icm); it must be for the document's colour
mode, and it's saved inside the document. To keep the colours and change
the numbers instead, use **Convert to Profile** (chapter 10).

### Colour Settings

**Edit → Colour Settings** (Ctrl+Shift+K):

| Setting | What it does |
| --- | --- |
| Display | The colour space of your screen. Browsers don't tell a page which profile a monitor has, so choose Display P3 for a wide-gamut screen and sRGB otherwise. On a wide-gamut screen Plexel starts with Display P3. The canvas, the thumbnails and the colour swatches are all shown in it. |
| Rendering intent | How colours are converted into a document: Perceptual (keeps the relationships between colours), Relative Colorimetric (keeps colours that fit exactly, clips the rest; the default), Saturation, or Absolute Colorimetric (also matches the paper colour). |
| Black point compensation | Maps the darkest black of one space to the darkest of the other, so shadows keep their detail. On by default. |
| Working spaces | The RGB, CMYK and Gray profiles Document → Mode converts to, and the CMYK one documents are proofed against to start with (chapter 10). |

### Memory

Pixels are kept in 256-pixel tiles. A layer of one colour costs almost
nothing, whatever its size. When memory gets tight, the tiles used least
recently move to the browser's private storage on disk and come back when
they're needed. The graphics card keeps the tiles in view, and smaller
copies of each layer for zoomed-out views, and lets go of what hasn't been
shown for longest when its memory fills. **Help → Graphics Information**
shows how many tiles there are, how much memory they use, and how much the
graphics card is holding.

## 4. The canvas

### Moving around

| To | Do |
| --- | --- |
| Move the image | Choose the **Hand** (H) and drag, or hold **Space** and drag with any tool, or drag with the middle button. The mouse wheel scrolls up and down, and Shift+wheel sideways. |
| Zoom in or out | **Ctrl+=** and **Ctrl+−** step through 100%, 200%, 66.7% and the rest. **Ctrl+wheel**, or pinching on a trackpad, zooms smoothly about the pointer. With the **Zoom** tool (Z), click to zoom in a step about the point you click, Alt-click to zoom out, or drag right and left to zoom smoothly. |
| See the whole image | **View → Fit on Screen** (Ctrl+0). |
| See every pixel as it is | **View → 100%** (Ctrl+1): one image pixel to one screen pixel. Above 100% the pixels are drawn as hard squares. |
| Frame the selection or a layer | **View → Zoom to Selection**, or **View → Zoom to Layer** for the selected layers. Double-click a layer's thumbnail in the Layers panel to zoom to that layer. |
| Turn the view | Choose **Rotate View** (R) and drag around the middle of the canvas; hold Shift to turn in 15° steps. **View → Rotate View Left 15°** and **Right 15°** turn it a step. Double-click with the tool, or choose **View → Reset Rotation**, to put it straight. |
| Jump somewhere else while zoomed in | **Hold H and press** on the canvas: the whole document shows, with a frame the size of the view you came from. Drag the frame where you want to be and let go; the view zooms back in there. Esc puts it back as it was. |
| See two views at once | **View → Split View**: the canvas splits in two, your view on the left and the whole document fitted on the right. Each pane zooms, pans and turns on its own, and every tool works in either; the one under the pointer is the one the zoom keys, the status bar and the rulers follow. Choose it again for one pane, keeping the view of the pane you were in. |

Turning the view turns how you see the image, not the image itself: it isn't
a change to the document and isn't in the history. Each document keeps its
own view while it's open. A document opens fitted to the window, no larger
than 100%.

**`** (the key left of 1) switches to the tool you had before, and again
back: say from the Brush to the Move tool and back to painting.

### How the canvas is drawn

The layers are combined on your graphics card, bottom first, each with its
blend mode, opacity and fill, as Photoshop combines them, so a document
looks the same in both. While part of the view is still being drawn, it
shows the last picture it had there, or a coarser one, and fills in a
moment later: moving around never waits.

CMYK documents blend as light, inks inverted, as Photoshop does, so Multiply
darkens and Screen lightens in CMYK as they do in RGB.

The canvas is shown through the document's colour profile and the
display's (Colour Settings), so the same numbers look the same in every
profile they're meant for. When the display is set to Display P3, the canvas
itself is Display P3, and wide-gamut colours aren't squeezed back into sRGB.

## 5. Painting

### The Brush and the Eraser

Select a pixel layer, choose the **Brush** (B), and paint. The **Eraser**
(E) works the same way and takes the layer back to transparency. Each
stroke is one step in the history, called Brush Stroke or Eraser.

- **Shift-click** draws a straight line from where the last stroke ended.
- **Esc** while the pen is down abandons the stroke.
- **Alt** with the Brush or Eraser picks a colour from the image instead.
- **[ and ]** make the brush smaller and larger; **Shift+[ and ]** softer
  and harder, a quarter at a time.
- **Alt and a right-drag** on the canvas (Ctrl+Option and a drag on a Mac)
  sizes the brush where you are: drag right for larger, left for smaller,
  up for harder and down for softer. The tip is drawn where the drag began,
  at its size on screen and filled to its hardness, with its numbers beside
  it. Quick Selection's brush sizes the same way.
- **The number keys** set the opacity: 1 is 10%, 5 is 50%, 0 is 100%, and
  two typed quickly are one number (4 then 5 is 45%). With **Shift** they
  set the flow instead. With the Mixer Brush they set its flow, and with
  Smudge its strength.

A stroke stops at the edge of the canvas, and with a selection, at the
selection's edge (chapter 6). A layer that's locked, hidden or not a pixel
layer isn't painted, and a message says why. Painting works on a
layer that's been moved, scaled or turned, and on a turned view: the paint
goes where the pointer is.

The outline that follows the pointer is the brush's size and shape: a
circle for a round tip, or the tip's own outline, turned and squashed as
the brush paints it. Under three screen pixels it becomes a small cross.

### Brush settings

The options bar shows the tool's settings. Drag a setting's name left or
right to change it, or type a value; ↑ and ↓ step it, Shift for ten.

| Setting | What it does |
| --- | --- |
| Brush | The preset the settings came from, or Custom once you change one. |
| Size | The brush's diameter in document pixels. |
| Hardness | How sharp the edge is, from soft to hard. Round tips only. |
| Mode | How the paint blends with the layer (Brush only). |
| Opacity | The most a single stroke covers. Going over the same place in one stroke never makes it more opaque than this; a new stroke does. |
| Flow | How much each dab of the brush adds. At low flow, paint builds up where the brush lingers or crosses itself, up to the opacity. |
| Spacing | The distance between dabs, as a share of the diameter. Larger spacing makes a dotted line. |
| Smoothing | How much the stroke lags behind the pen to steady a shaky hand. The stroke catches up when you lift the pen. |
| Pressure: size, opacity, flow | Whether pen pressure sets each of them. A mouse always paints at full pressure. |

The **Brushes** panel (Window → Brushes) lists the presets with a stroke
drawn by each: Hard Round, Soft Round, Inking Pen, Airbrush, Pencil,
Calligraphy, Chalk, Spatter and Dry Bristle. Click one to give it to the
Brush, or to the Eraser when that's the tool in use. **Save Current Brush**
keeps the current settings as a preset of your own; × removes one. Every
other setting of the brush, section by section, is in the **Brush
Settings** panel (F5), in chapter 12.

### The pen

Plexel reads a pen's pressure, tilt and twist from every sample the
browser has, not only one a frame. **Edit → Pen Settings** sets how pressure
responds, from soft (light pressure already does a lot) to firm (it takes a
heavier hand); press the pad in the dialog to try it.

### Picking colours

Choose the **Colour Picker** (I) and click the image to make that colour the
foreground; Alt-click for the background. It picks from everything you see,
all the layers together. **Sample** in the options bar picks one pixel, or
averages a 3 × 3 or 5 × 5 square.

**A colour picker at the pointer**: with a painting tool or the Colour
Picker, hold **Shift+Alt** and drag with the right button (Ctrl+Option+Cmd
and a drag on a Mac), as in Photoshop. A shade square opens under the
pointer, with the foreground's place in it where you pressed, and a hue
strip beside it: move in the square for the shade, or across onto the
strip for the hue. The foreground follows; let go to keep it, or press
**Esc** for the colour you had.

### Swatches

The **Swatches** panel (Window → Swatches) keeps colours for reuse. Click a
swatch for the foreground, Alt-click for the background. **Drag a swatch
onto a shape** (or text) on the canvas to fill it with that colour; hold
Shift as you let go to stroke it instead. **Add
Foreground** keeps the current foreground; a right-click, or Delete on a
focused swatch, removes one, and **Reset** brings back the starting set. A
swatch keeps the colour space it was picked in, so a CMYK swatch stays the
same inks. These are kept in the browser, for any document; swatches kept
in the document itself, global colours and spot colours are in chapter 10.

### Undo and memory

Every stroke keeps the parts of the layer it painted over, so it can be
undone. History holds the last hundred steps, and at most 1 GB of tiles that
only older steps need: past that, the oldest steps are forgotten first.

## 6. Selections, masks and transforms

### Selecting

A **selection** says which part of the image the next thing you do works
on: painting, filling, clearing, a new mask. Its edge is shown by
**marching ants**. A selection can be soft: a feathered edge is partly
selected, and what's done through it fades out there.

- **The Marquee** (M) selects a rectangle or an ellipse (choose which in the
  options bar). Hold Shift once you've started dragging for a square or a
  circle, and Alt to draw from the middle out.
- **The Lasso** (L) selects what you draw round. In **Polygonal** mode,
  click each corner instead; click the first corner, double-click or press
  Enter to close the shape, and Esc to give up. As in Photoshop:
  - Drawing freehand, hold **Alt** and let go of the button: the Lasso
    carries on in straight sides, a click for each corner (drag without
    Alt for freehand again). Let go of Alt to close it.
  - In Polygonal mode, **Alt-drag** draws freehand, and **Shift** keeps
    the next side to 45°.
  - **Backspace** (or Delete) takes the last corner, or freehand piece,
    back; with nothing left to take, the lasso is cancelled.
- **The Magic Wand** (W) selects pixels like the one you click. **Tolerance**
  says how different a colour may be (on any channel, from 0 to 255) and still
  be selected. **Contiguous** keeps to pixels joined to the one clicked; turn
  it off to take matching colours anywhere. **Sample all layers** compares
  the whole picture rather than just the selected layer.

Each selection tool combines a new shape with the selection there is.
Hold **Shift** when you start to add to it, **Alt** to take away, and both
to keep only where they overlap; or choose New, Add, Subtract or Intersect
in the options bar. **Feather** in the options bar softens the edge of
shapes you draw, and **Anti-alias** smooths their edges rather than
leaving them stepped.

Drag inside the selection with a selection tool to move the outline;
the arrow keys nudge it. A click without dragging deselects.

The **Select** menu:

| Command | What it does |
| --- | --- |
| All (Ctrl+A) | Selects the whole canvas. |
| Deselect (Ctrl+D) | Lets the selection go. |
| Reselect (Ctrl+Shift+D) | Brings back the selection you last let go of. |
| Inverse (Shift+F7) | Selects everything that wasn't, and nothing that was. |
| Feather… (Shift+F6) | Softens the edge over the distance you give. |
| Expand…, Contract… | Moves the edge out or in, up to 256 pixels. |
| Select and Mask… (Ctrl+Alt+R) | Refines the edge, showing the result on the canvas as you go: **Smooth** rounds off jagged edges and small corners, **Feather** softens, **Contrast** sharpens a soft edge, and **Shift Edge** moves it in or out. |
| Quick Mask (Q) | Shows the selection as a red tint over what isn't selected, and lets you paint it (below). |

A selection is part of the document's history, as in Photoshop: Undo takes
a selection back like any other change, and a saved file keeps it.

### Working through a selection

With something selected, the Brush and the Eraser only paint inside it (a
soft edge lets some through), **Edit → Fill with Foreground** and **Fill
with Background** fill only it, and **Delete** clears only it, to
transparency. With nothing selected, Fill fills the whole layer and Delete
deletes the layer.

**Document → Crop to Selection** crops the canvas to the selection's edges.

### Quick Mask

Press **Q** to see the selection as a red tint over everything that isn't
selected, and paint it with the Brush: white selects, black takes away, and
greys select partly. The Eraser paints the background colour. Press Q again
to go back to marching ants. Going into Quick Mask with nothing selected
selects everything first, so there's something to paint away.

### Layer masks

A **layer mask** hides parts of a layer without deleting them: where the
mask is white the layer shows, where it's black it's hidden, and greys show
it partly. Any layer or group can have one.

**Layer → Layer Mask** adds one:

| Command | The new mask |
| --- | --- |
| Reveal All | Shows the whole layer. |
| Hide All | Hides the whole layer. |
| Reveal Selection | Shows the layer only where it's selected. |
| Hide Selection | Hides it where it's selected. |

The mask's thumbnail appears beside the layer's in the Layers panel, framed
when it's what you're working on. Click it to paint on the mask with the
Brush (white shows, black hides; the Eraser paints the background colour),
and fill or clear it through a selection. Click the layer's own thumbnail to
go back to its pixels. **Shift-click** the mask's thumbnail to turn the mask
off and on (a crossed-out thumbnail is off); **Ctrl-click** loads it as the
selection, for a mask made from a selection and not changed since.

With the mask chosen, the **Properties** panel shows its settings:

| Setting | What it does |
| --- | --- |
| Density | How much the mask hides: at 50%, its black hides half. |
| Feather | Softens the mask's edges, live: the mask itself isn't changed, so you can come back and change it. |
| Invert | Swaps what the mask shows and hides. |
| Enabled | Turns the mask off and on. |
| Apply | Makes the layer's pixels match what the mask shows, and removes the mask (pixel layers). |
| Delete | Removes the mask, leaving the layer whole. |

A mask moves with its layer.

### Clipping

**Layer → Create Clipping Mask** (Ctrl+Alt+G) clips the selected layer to the
layer below it: it shows only where that layer has pixels. The layer goes
inside the one below it in the Layers panel, marked with a hook. The same
command (then called Release Clipping Mask) takes it out again. Dragging a
layer into or out of another does the same.

### Moving and transforming

- **The Move tool** (V) moves the selected layers: drag them, holding Shift
  to keep the move straight across or straight down. The arrow keys nudge
  them a pixel, Shift ten. Moving a group moves everything in it.
- **Picking a layer on the canvas**: with the Move tool, **Ctrl-click**
  selects the topmost layer under the pointer, one that shows there (a
  clear pixel, or a masked-out one, doesn't count). Add **Alt** to pick
  the one below that instead, and again to go deeper, round to the top;
  add **Shift** to add the layer to those selected. Turn on **Auto-Select**
  in the options bar and a plain press picks the layer, then drags it;
  Ctrl then turns it off for that press. Auto-Select can pick the layer,
  or the outermost group holding it.
- **Edit → Free Transform** (Ctrl+Alt+T) puts a box with handles round the
  selected layer (or, with several selected, round all of them). Drag a corner to scale it, keeping its proportions (Shift
  lets them go), and an edge's middle to stretch it one way; hold Alt to
  scale about the middle. Ctrl-drag an edge's middle to skew. Drag inside
  the box to move it, and outside to turn it, Shift in 15° steps. The
  options bar shows its size and angle. **Enter** commits it as one step;
  **Esc** cancels it.
- **Edit → Transform** flips the layer horizontally or vertically, or turns
  it 90° either way or 180°; its **Distort**, **Perspective** and **Warp**
  open Free Transform in that mode (chapter 19).

Transforms are **live**: the layer keeps its own pixels and is redrawn
through the transform with its Resampling setting, so scaling down and
back up loses nothing. **Layer → Rasterize** bakes the transform into the
layer's pixels when you want it fixed.

A layer that's locked, or locked in position, can't be moved or
transformed.

### Cropping

Choose **Crop** (C) and a box appears round the canvas. Drag its handles to
choose what to keep, drag inside it to move it, and drag outside it to turn
it, to straighten a crooked picture. Everything outside is shaded. **Enter**
crops; **Esc** gives up.

Cropping changes the canvas, not the layers: nothing outside the crop is
deleted, so **Canvas Size** can bring it back.

## 7. Adjustments, filters, layer styles and smart objects

Everything in this chapter changes how a layer looks without changing its
pixels, and can be changed again or taken away at any time.

### Adjustment layers

**Layer → New Adjustment Layer** adds an adjustment above the selected
layer. It changes how everything under it looks, as if it were a sheet of
coloured glass:

| Adjustment | What it does |
| --- | --- |
| Levels | Sets the darkest and lightest tones (Black and White) and the middle's brightness (Gamma), and the range they go out to, for all channels together or one at a time (each channel's own first, then all together, as in Photoshop). The histogram shows how the document's tones are spread. |
| Curves | Reshapes the tones with a curve: drag a point, click the curve to add one, drag a point off the square or double-click it to take it away. All channels together, or each on its own. |
| Brightness/Contrast | Brighter or darker, and more or less contrast about the middle, as a curve that keeps black and white where they are, as Photoshop's does. **Use legacy** is the old version, which shifts and stretches every value and clips at both ends. |
| Exposure | Exposure in stops, an offset, and gamma, worked in linear light as in Photoshop. |
| Invert | Light becomes dark, colour its opposite. |
| Posterize | Leaves only so many levels per channel. |
| Threshold | Every pixel black or white, by whether it's lighter than the level. |
| Hue/Saturation | Turns every hue round, makes colours stronger or weaker, lighter or darker; Colourise gives the image one hue. **Range** picks Master (every colour) or one of Reds, Yellows, Greens, Cyans, Blues and Magentas, each with its own settings, changing only colours near that hue. |
| Vibrance | Strengthens dull colours more than strong ones. |
| Colour Balance | Shifts shadows, midtones and highlights towards red, green or blue (or cyan, magenta, yellow), keeping the lightness if asked. |
| Black & White | Gray from colour, with how bright each of reds, yellows, greens, cyans, blues and magentas should come out; Tint colours the result. |
| Channel Mixer | Builds each channel from a mix of the others; Monochrome makes one gray channel. |
| Gradient Map | Each tone becomes the colour at that point on a gradient. |
| Selective Colour | Adds or takes away cyan, magenta, yellow and black in one range of colours at a time (Reds round to Blacks, Whites and Neutrals), Relative to the ink there or Absolute. |
| Photo Filter | A coloured filter over the lens: Photoshop's warming, cooling and colour filters, or a colour of your own, at a Density, keeping the lightness if asked. |
| Colour Lookup | A look: Warm, Cool, Teal and Orange, Film, Bleach Bypass, Sepia, Day for Night, Faded or Crisp, or **From a file**, a `.cube` 3D lookup table as cameras and grading software make them (Load… in Properties; the table is kept in the document). |
| Colour Grading | Four colour wheels, for the shadows, midtones, highlights and the whole image: drag the dot towards a hue, further for more; each with its own luminance. Balance moves where shadows end and highlights begin; Blending how much they overlap. |

Its settings are in the **Properties** panel; a drag of one control is one
step in the history. Like any layer, an adjustment has an opacity, a blend
mode (Curves in Luminosity changes tones without shifting colours), a mask
(Layer → Layer Mask) and an eye. Clipped to the layer below
(Ctrl+Alt+G), it adjusts only that layer.

In a CMYK document the tone adjustments (Levels, Curves and the rest) work
on the inks, as Photoshop's do; the colour adjustments work on a simple RGB
view of the inks, so they can differ a little from Photoshop's.

**Document → Adjustments** applies any of them straight to the selected
layer, as Photoshop's Image → Adjustments do: its dialog shows the result
as you set it, and OK changes the layer's pixels for good (only what's
selected, with a selection), or, with **Live** ticked, adds it to the
layer's effects instead.

### Filters

The **Filter** menu has Photoshop's submenus: Blur, Distort, Noise,
Pixelate, Render, Sharpen, Stylize and Other (and Liquify, chapter 19).
Each filter opens a dialog that shows the result on the canvas as you set
it. Nothing is dimmed behind the dialog, so you see the result as it will
be; drag on the canvas to move around it (the wheel zooms), and drag the
dialog by its title bar to see past it. Every dialog opens where you last
left it; double-click its title bar to put it back. The adjustment, Layer
Style, Offset Path and Simplify dialogs work the same way.

With **Live** ticked (as it is unless something is selected), the filter
goes in the layer's effects, listed under the layer in the Layers panel.
Click it there to change its settings in Properties, including how
strongly it's mixed in (Opacity); its eye hides it. A layer's effects run
in order, top of the list first. **Filter → Apply Live Filters** makes them
part of the layer's pixels and takes them off.

Untick Live, or filter with a selection, and the filter changes the
layer's pixels for good, only where they're selected.

A live filter has a **Blend mode** of its own in Properties as well as an
opacity, as Photoshop's smart filters' blending options: the filtered
layer laid over the unfiltered one in that mode.

**Layer → New Filter Layer** adds a filter as a layer of its own, as
Affinity's live filter layers are: it filters everything below it (in its
group, if the group isn't pass-through), with its own opacity and mask,
and its settings in Properties.

| Filter | What it does |
| --- | --- |
| Gaussian Blur | A soft blur; Radius is how far it spreads. |
| Box Blur | An even blur over a square. |
| Unsharp Mask | Sharpens edges by Amount over Radius, leaving differences under Threshold alone. |
| High Pass | Keeps only edges and fine detail, on gray; useful with Overlay or Soft Light. |
| Add Noise | Grain, uniform or Gaussian, coloured or monochromatic. The same every time. |
| Median | Each pixel becomes the middle value round it, removing specks. Up to 5 pixels. |
| Motion Blur | A blur along one direction. |
| Lens Blur | Out of focus as a lens is: an even disc, Radius its size; the brightest spots bloom into discs (Specular brightness, over a Threshold). |
| Surface Blur | Blurs flat areas but keeps edges: only pixels within about Threshold of each other are mixed. |
| Smart Sharpen | Sharpens by taking out a blur of its kind (Gaussian, Lens or Motion), leaving differences under Reduce Noise alone. |
| Twirl, Pinch, Spherize, ZigZag | Turns, pinches, bulges or ripples the circle in the layer's box, its edge staying put. They're kept on the box the layer's content had when they were added, so they follow it when it moves. |
| Wave, Ripple | Waves across and down the layer: Wave's of several lengths and heights, sine, triangle or square; Ripple's small and regular. |
| Polar Coordinates | Wraps the layer's box round its middle, or unwraps it. |
| Displace | Moves each pixel by a map: one of the document's patterns (Edit → Define Pattern), stretched over the layer or tiled; its light moves things one way, its dark the other. |
| Dust & Scratches | Smooths specks: pixels that differ from round them by more than the threshold become the middle value round them. |
| Mosaic | Squares of the colour of the pixels in them. |
| Clouds | Soft clouds between two colours, on the layer's shape; a seed for others. |
| Lighting Effects | A light at an angle and a height on the layer as a surface its lightness raises, with ambience and gloss. |
| Emboss | The layer raised in gray, lit from an angle. |
| Find Edges | Edges dark on white. |
| Solarize | The light half turned dark, as an overexposed print. |
| Minimum, Maximum | Each pixel the darkest (or lightest) round it: thinner, darker lines, or wider, lighter ones. |
| Offset | Moves the layer round its canvas (chapter 17). |

Filters work at every zoom: a blur looks the same at 25% as at 100%.

### Layer styles

**Layer → Layer Style…** (or double-click "fx" on a layer in the Layers
panel) adds effects to a layer: tick one in the list on the left and set it
on the right. The canvas shows them as you go; OK keeps them as one step.

| Effect | What it does |
| --- | --- |
| Drop Shadow | A shadow behind the layer, away from the light's angle, blurred by Size, hardened by Spread. |
| Outer Glow | A glow round the layer. |
| Inner Shadow | A shadow inside the layer's edge. |
| Inner Glow | A glow inside, from the edge or from the centre. |
| Satin | Soft shading inside the shape. |
| Colour Overlay | The layer in one colour. |
| Gradient Overlay | The layer in a gradient, at an angle across it. |
| Pattern Overlay | The layer in a pattern (checkerboard, stripes, dots or a grid) in two colours, sized and turned; the pattern stays put when the layer moves. |
| Bevel & Emboss | Highlights and shadows that make the layer look raised (or sunk, Down). |
| Stroke | An outline outside, inside or centred on the edge. |

Each has its own blend mode and opacity. The layer's **Fill** fades its
content but not its effects, so a shape at 0% fill with a stroke is just
the stroke. **Clear Layer Style** takes them all off. Effects follow the
layer's mask.

### Smart objects

**Layer → Smart Objects → Convert to Smart Object** puts the selected
layer inside a smart object: a document of its own, drawn in this one.
Scale it down and back up and it's as sharp as it was, because it's always
drawn from its contents. Filters and layer styles work on it as on any
layer.

**Edit Contents** opens its contents in a tab of their own. Change them,
then **Save** (Ctrl+S): the smart object is updated in the document it
belongs to, as one step there. **Layer → Rasterize** makes a smart object
an ordinary pixel layer again.

## 8. Shapes and paths

Shapes and paths are layers like any other: they take masks, filters,
layer styles, opacity, blend modes and clipping. They're drawn from their
outlines whatever the zoom, so their edges stay sharp, and they keep their
settings until you change them.

### Drawing shapes

The **Shape tool** (U) draws rectangles, ellipses, polygons, stars and
lines: choose which in the options bar, then drag on the canvas. Shift
keeps a shape square or round (a line at 45° steps); Alt draws it from the
middle out.

The options bar also has the chosen shape's settings (a rectangle's corner
radius and style, a polygon's sides, a star's points and inner radius)
and, for new shapes, **Fill** (with the foreground colour) and **Stroke**
(with the background colour when the shape is filled too, otherwise the
foreground) and the stroke's **Width**. A line is always stroked.

A shape stays **live**: select it and Properties shows its box (X, Y, W, H)
and its settings, which can be changed at any time. **Convert to Path**
(also in the Layer menu) turns it into a path whose points can be edited;
its settings go.

### The Pen

The **Pen** (P) draws paths point by point:

- Click to place a corner; drag to pull out handles and make a curve. The
  handles mirror each other; hold Alt to move only the one ahead.
- The next segment follows the pointer until you click.
- Click the **first point** to close the path. **Enter** finishes it open;
  **Esc** throws it away. Switching tools finishes it too.

The new path is a shape layer, filled and stroked as the options bar says.
With a path selected, the Pen also edits it: click a segment to add a
point (the curve doesn't change), click a point to delete it, Alt-click a
point to turn it from corner to smooth or back, and click an open path's
end to carry it on.

**Smart** in the options bar (as Affinity's Pen has it): a click places a
smooth point, its curve worked out from the points either side, and the
next segment shows as it will curve; Alt-click places a corner, and a drag
still pulls the handles out by hand.

### The Curvature tool (Shift+P)

The **Curvature** tool (in the Pen's group: Shift+P switches between them)
draws curves from points alone:

- Click to place smooth points; the curve runs through them, each point's
  handles along the line between its neighbours. Alt-click places a corner.
- Click the first point to close the path; Enter finishes it open.
- On the selected path: drag a point to move it, the curve through its
  neighbours following; double-click a point to make it a corner, and
  again to make it smooth; click a segment to add a smooth point (and drag
  it straight away); click an open end to carry the path on.

Points show as **rounds** when they're smooth and **squares** when they're
corners, with whichever tool shows them.

### The Width tool (Shift+P)

The **Width** tool, also in the Pen's group, makes a stroke wider or
narrower along its path, as Illustrator's does. It works on the topmost
stroke of the selected shapes, or of any stroked shape you press on, which
it then selects.

- Hover the stroke and a line across it shows where a width point would
  go. **Drag** the stroke to add a point there and widen it (or narrow it)
  as you drag.
- Each width point shows as a line across the stroke: a round point in the
  middle and a diamond at each edge. Drag an **edge** to change the width
  there; both sides change in proportion, or with **Alt** only that side.
- Drag a point's **middle** to slide it along the path, between the points
  either side; **Alt**-drag to slide a copy of it instead.
- **Shift**-click points to select several: dragging the edge of one of
  them widens them all. **Delete** removes the selected points.
- **Double-click** a point for Width Point Edit: each side's width and the
  whole width, in pixels (changing the whole keeps the sides' proportion),
  and Delete.

The points are the stroke's profile, so Properties shows it as **Custom**
once you've changed it, and Uniform makes it even again. A path of several
parts takes the same profile along each. On a closed path the point where
it starts is also where it ends: changing one changes both.

### Drawing freehand (N)

Three tools share the **N** slot (Shift+N goes from one to the next), as
in Illustrator:

- **Pencil**: drag to draw a path as your hand goes; it's smoothed into
  curves when you let go. End near where you began and it closes.
- **Paintbrush**: the same, stroked with a vector brush (choose it in the
  options bar, or Basic for a plain stroke). Its **Width** is how tall
  the brush's artwork is on the path.
- **Blob Brush**: paints filled shapes in the foreground colour, like a
  marker. Where a stroke touches a shape of the same colour (filled, with
  no stroke) in the same group, they become one shape. [ and ] change its
  **Size**; **Merge only with selection** joins only the selected shapes.

**Fidelity** says how smooth: how far the curve may stray from your hand,
in screen pixels (small follows every wobble, large is smooth), so it
feels the same at any zoom.

With **Edit selected** on (the Pencil's and the Paintbrush's), a stroke
that starts on the selected path and ends on it again redraws the part
between; one that starts at an open path's end carries it on. **Keep
selected** keeps each new path selected, so the next stroke near it
reshapes it. **Fill** fills new paths with the background colour.

### Editing points

**Direct Selection** (A) shows the points of every selected shape:

- Click a point to select it, Shift-click to add one (of any selected
  shape), or drag a box round several: the box takes the points of every
  shape it reaches and selects those shapes. Drag to move them, on all the
  shapes at once, as one step; their handles come with them.
- Drag a selected point's handle to reshape its curves. A smooth point's
  other handle turns to stay in line; hold Alt to break them apart.
- Alt-click a point to convert it; **Delete** removes the selected points.
- Click a segment to select the points at its ends, and drag it.
- Click another shape on the canvas to select it; Shift-click to add it.

Editing a live shape's points turns it into a path.

### Fills and strokes

Properties shows a shape's **Appearance**: its fills and strokes, the top
one drawn last, as Illustrator lists them. **+ Fill** and **+ Stroke** add
one; each has a checkbox to show or hide it, arrows to move it up and down,
and × to remove it. Click one to set it:

| Setting | What it does |
| --- | --- |
| Paint | **Colour**, **Gradient** or **Pattern**. |
| Colour | Its chip: click it for the colour picker. |
| Gradient | Linear, radial, angular or diamond, across the shape's box: its stops (each with a position, a colour and an opacity), angle, scale and Reverse. |
| Pattern | Checkerboard, stripes, dots or a grid, in a colour over a background (which can be see-through), its size and angle. It moves and turns with the shape. |
| Opacity, Blend mode | How it's laid over the fills and strokes below it. |
| Width | A stroke's width in pixels. |
| Align | Centre (straddling the outline), Inside or Outside. Inside and outside apply to closed paths. |
| Corners, Ends | Miter (with its limit), round or bevel corners; butt, round or square ends. |
| Dashes | Lengths, dash then gap: "8 4" is dashes of 8 with gaps of 4. "0 6" with round ends makes dots. Dash offset slides them along. **Align dashes to corners** stretches them a little so every corner and end has a dash, half either side of a corner. |
| Profile | How wide the stroke is along the path: Uniform, Taper Both, Taper Start, Taper End, Bulge, Pinch or Brush, a profile you saved, or Custom when the Width tool has shaped it. **Flip Along** turns it end to end, **Flip Across** side to side; **Save…** keeps it by a name, listed after the presets (in this browser), and **Forget** takes a saved one out of the list. |
| Start, End | An arrowhead at either end of an open path (Triangle, Stealth, Open, Circle, Square, Diamond or Bar), filled with the stroke's paint, and its size. |

**Scale Strokes**, in the Move tool's options bar and Free Transform's,
says whether scaling a shape scales its strokes with it (on, as before) or
leaves them as wide as they were (off), as Illustrator's Scale Strokes &
Effects does.

In SVG and PDF a stroke with a profile, arrowheads or aligned dashes is
written as its outline, filled, so it looks exactly the same; a PSD keeps
the look in the layer's pixels, and its live stroke is a plain one.

A path's **Fill rule** says what's filled where it crosses itself: Non-zero
fills it all, Even-odd leaves holes where outlines overlap.

### Effects on one fill or stroke

Each fill and stroke has **Effects** of its own, as Illustrator's
appearance does (Affinity has none per fill). Open the fill or stroke in
Properties and choose from **Add…**:

- **Path** effects change the outline that fill or stroke is drawn from:
  **Transform** (moved, scaled and turned, with copies, each from the
  last), **Offset Path** (out, or in when negative, with mitred, round or
  bevelled corners), **Roughen**, **Pucker & Bloat**, **Zig Zag** and
  **Warp** (the warp styles).
- **Pixel** effects work on what it paints: any live filter that doesn't
  move things about the canvas (blurs, noise, Lighting and the rest), and
  **Drop Shadow** and **Outer Glow**.

They run in order, top first; each has a checkbox, arrows and ×, and its
settings below the list. Two strokes of one shape, one offset and blurred
into a glow, the other crisp on top, is one shape.

A shape with effects on a fill or stroke goes to SVG and PDF as an image
of itself, and to Photoshop without them (said).

### Graphic styles

**Window → Graphic Styles** keeps named looks in the document: fills,
strokes and their effects together.

- **New from Selection** makes one from the selected shape (or compound
  shape, or text), which is then linked to it.
- **Click a style** to give it to the selected shapes and text, linked.
- **Redefine** (the arrow on a style's row) makes the style the selected
  shape's look, and every shape linked to it changes to match.
- A change to a linked shape's own fills and strokes breaks its link, as
  in Illustrator; **Break Link** does it without a change. Properties says
  which style a shape is linked to.
- Double-click a name to rename it; × deletes the style, its shapes keeping
  their looks.

Copying a linked shape into another document brings its style too.

### Vector brushes

A stroke can draw artwork along its path instead of a plain line, as
Illustrator's brushes do. **Window → Vector Brushes** lists the
document's brushes and the built-in ones, each drawn along a curve:

- **Art** brushes bend one piece of artwork along the whole path
  (Tapered Ink, Arrow, Ribbon).
- **Scatter** brushes put copies of it along the path, each varied in
  size, spacing, distance from the path and rotation (Dots, Stars,
  Confetti).
- **Pattern** brushes repeat a tile along the path, bent with it, with
  their own tiles at the ends and the corners if they have them (Rope,
  Railroad, Beads).

**Click a brush** to stroke the selected shapes and text with it (a shape
without a stroke gets one). The stroke's **width** is how tall the
artwork is on the path, its width profile shapes it, and its opacity,
blend mode and effects are the whole brush's; its dashes, corners, ends
and arrowheads don't apply. In Properties a stroke's **Brush** chooses
one, or None for a plain stroke.

**New from Selection** (or Layer → Brushes) makes an art, scatter or
pattern brush of the selected shapes: their fills, and their strokes as
outlines, each in its colour. **Brush Options** (double-click a brush, or
its sliders button) sets:

| Setting | What it does |
| --- | --- |
| Colorization | **None** keeps the art's colours. **Tints** uses the stroke's colour, lighter where the art is lighter; **Tints and Shades** darker too; **Hue Shift** turns the art's main colour into the stroke's and the rest with it. |
| Fit (art) | **Stretch to fit** the path's length; **Scale in proportion** (a longer path is a wider stroke); **Stretch between guides**, where the art's start and end (a share of its length each) keep their shape, as an arrowhead should. |
| Width, Flip | How tall the art is as a share of the stroke's width; flipped end to end or side to side. |
| Size, Spacing, Scatter, Rotation (scatter) | Each a lowest and highest value, every copy taking one between them: size as a share of the stroke's width, spacing as a share of a copy (100% touches), scatter off the path either side, rotation in degrees from the path's direction or the page's. **Vary Again** shuffles them. |
| Fit, tiles (pattern) | Tiles **stretched** to fit a whole number along the path, or kept their length with **space** added; the side, start, end and corner tiles each taken from the selected shapes. Corners are where the path turns sharply; without a corner tile the side tiles bend round them. |

OK keeps the brush in the document (a built-in one edited is kept under
its name) and, if you leave it ticked, changes the strokes drawn with it.
Each stroke keeps its own copy of its brush, so it looks the same pasted
into another document. **Remove Brush Stroke** makes the selected strokes
plain again; **Outline Stroke** makes a brush stroke's artwork shapes of
their own, grouped.

In SVG and PDF a brush stroke is written as its artwork, filled, so it
looks the same; a PSD keeps the look in the layer's pixels and its live
stroke is plain.

### Image Trace

**Layer → Image Trace** turns a pixel layer (or a placed image) into
shapes, as Illustrator's does. It opens beside the canvas and shows the
result as you change it, with how many paths, anchors and colours it
makes:

| Setting | What it does |
| --- | --- |
| Preset | Default (black and white), High and Low Fidelity Photo, 3, 6 and 16 Colours, Shades of Gray, Black and White Logo, Sketched Art, Silhouettes. Changing a setting makes it Custom. |
| Mode | **Black and White** (pixels darker than the **Threshold** are black), **Grayscale** or **Colour**, with how many grays or colours. |
| Paths | How far curves may stray from the pixels' edges: small for detail, large for smooth, simple shapes. |
| Corners | A turn sharper than this stays a sharp corner. |
| Noise | Specks smaller than this many pixels join what's round them. |
| Blur first | Softens a photo's grain before its colours are counted. |
| Ignore white | Leaves the white out, for line art over a white background. |

**Trace** makes a group above the layer with one shape per colour (every
area of that colour in one path), and hides the layer unless you untick
**Hide the image once traced**. Neighbouring shapes share their edges
exactly, so there are no gaps between them and nothing overlaps. Images
larger than 2,400 pixels a side are traced at that size and scaled back
up. See-through pixels are left out.

### Compound shapes

**Layer → Combine Shapes** combines the selected shape with the one right
below it in the Layers panel:

| Command | Result |
| --- | --- |
| Unite Shapes | Both together. |
| Subtract Front Shape | The one below with the selected one cut out of it. |
| Intersect Shapes | Only where they overlap. |
| Exclude Overlapping Shapes | Both, except where they overlap. |

They become a **compound shape**, painted with the bottom shape's fills and
strokes; its own Appearance changes them. Its shapes are listed inside it,
each marked with how it combines; select one to change that in Properties,
or to move or edit it, and the compound follows. Hidden shapes are left out.
Combining a shape with a compound below it adds it to the compound.

**Expand Compound Shape** makes it one path with the combined outline (its
curves stay curves). **Release Compound Shape** puts the shapes back as
separate layers.

### Pathfinder

**Layer → Pathfinder** works on any number of selected shapes at once and
makes new paths of them (where Combine Shapes stays live):

| Command | Result |
| --- | --- |
| Unite, Minus Front, Intersect, Exclude | All of them together; the bottom one with the rest cut out; where they all overlap; where an odd number of them do. |
| Divide | Every region their outlines cut each other into, a shape of its own, in the colour of the shape on top there, in a group. |
| Trim | What shows of each: each less the shapes above it. Strokes go. |
| Merge | Trim, then the pieces painted alike made one. |
| Crop | The top shape cuts every shape below to itself, and goes. |
| Minus Back | The top shape with every one below cut out of it. |

The results' curves are the shapes' own curves.

### The Shape Builder (Shift+U)

With shapes selected, choose the **Shape Builder** (it shares U with the
Shape tool). The region under the pointer is outlined. **Drag** across
regions to merge them into one shape, in the look of where the drag
began; **Alt-drag** to delete them. The shapes are cut into their regions as
it does, each keeping the look of the shape on top of it, and the new
shapes stay selected, to keep building.

### Live Paint (Shift+U)

A **Live Paint group** paints the regions between paths, the regions found
again whenever a path changes. Choose the **Live Paint Bucket** and click a
region between the selected shapes: they become a group (each region
filled as the shape on top was), and the region clicked takes the
foreground colour; **Alt-click** empties a region. The paths' strokes are
drawn over the regions. **Layer → Live Paint → Make** makes one without
painting; **Expand** turns it into shapes, the regions and the paths'
strokes; Release Compound Shape gives back the paths.

### Path commands

**Layer → Path**:

- **Outline Stroke**: the selected shape's top stroke becomes a shape of
  its own just above it, filled with the stroke's paint (inside and
  outside strokes as they look).
- **Offset Path…**: a new shape just below, its outline moved out (or in)
  by the offset, with mitred, round or bevelled corners.
- **Join**: with two end points selected (of one shape or two), joined
  by a straight segment, or made one point where they meet (the second
  shape's path goes into the first). With shapes selected and no points,
  their paths joined into one shape, open ends nearest each other first;
  one shape's two nearest open ends joined, or one open path closed.
- **Break at Points**: the paths cut at the selected points; a closed path
  opens there.
- **Separate**: each part of a shape (a compound path) a shape of its own,
  with the same look.
- **Simplify…**: the path redrawn with fewer anchors, within a precision,
  keeping corners sharper than an angle; the dialog counts the anchors.
- **Smooth**: every anchor made smooth.

### Vector masks

A layer can have a **vector mask** as well as a pixel mask: an outline that
shows what's inside it. **Layer → Vector Mask → Reveal All** adds one that
shows everything until it has an outline, **Hide All** one that hides
everything. Its thumbnail (rounded) sits beside the layer's; while it's
chosen, the Pen and the Shape tool draw outlines into it, and Direct
Selection edits them. In Properties it has Density, Feather and Invert, as
a pixel mask does. **Delete Vector Mask** and **Disable Vector Mask** are in
the same submenu; Shift-click its thumbnail to turn it off and on.

### Transforming and rasterizing

Free Transform (Ctrl+Alt+T), the Move tool and the arrow keys work on shapes
and compound shapes; a stroke scales with its shape. With the **Move tool**,
selected shapes (one or several) show Free Transform's box and handles
without Ctrl+Alt+T: drag a handle to scale (Shift freely, Alt from the
centre, Ctrl on an edge to skew), just outside a corner to turn, inside to
move. Each drag is one step. **Layer → Rasterize**
turns a shape into a pixel layer that looks the same.

## 9. Type

Text is a layer like any other: it takes masks, effects, layer styles,
opacity, blend modes and clipping. It's drawn from the font's outlines at
whatever zoom you're at, and it stays editable until you turn it into
shapes or pixels.

### Setting text

Choose the **Type tool** (T), then:

- **Click** to start **point text**: one line that grows as you type, with
  new lines only where you press Enter.
- **Drag a box** for **area text**: the lines wrap to fit the box. When
  there's more text than fits, Properties says so; the rest is kept, just
  not shown, until the box is made bigger or the text smaller.
- **Click a closed shape's outline** for area text **inside the shape**:
  each line is as wide as the shape is where the line falls.
- **Alt-click a shape's outline**, or click an open path, for **text on a
  path**: it runs along the outline from where you clicked. Properties has
  **Start along the path** to move it. Text that runs past the path's end
  isn't shown, and Properties says so.

The text takes a copy of the shape's outline; the shape stays where it was,
and changing it later doesn't change the text.

Nothing is added to the document until you type the first character. A new
text layer is named after what you type in it. **Esc** or **Ctrl+Enter**
finishes; so does choosing another tool. The whole of a new text layer is
one step in the History, and Undo takes it away.

### Editing text

Click text with the Type tool to put the caret there. Then:

| Keys | What they do |
| --- | --- |
| Arrows | Move a character (left, right) or a line (up, down). With Ctrl, a word at a time. |
| Home, End | The start or end of the line; with Ctrl, of the text. |
| Shift with any of these | Selects as it moves. |
| Backspace, Delete | Delete the selection, or a character either side; with Ctrl, a word. |
| Enter | A new paragraph. Shift+Enter breaks the line within the paragraph. |
| Ctrl+A | Selects all of the text. |
| Ctrl+Z, Ctrl+Shift+Z | Undo and redo, without leaving the text. A run of typing undoes as one step; moving the caret starts a new one. |
| Ctrl+X, Ctrl+C, Ctrl+V | Cut, copy and paste, as plain text. |

Drag to select, Shift-click to carry a selection to where you click,
double-click to select a word, triple-click a paragraph.
Text from an input method (Japanese, Chinese, Korean and others) is
underlined while you compose it and goes in when you choose it.

Plexel lays out right-to-left scripts (Arabic, Hebrew) and mixed text the
Unicode way, joins Arabic letters, and builds Devanagari's clusters. Lines
break where Unicode allows, so URLs, punctuation and scripts without spaces
behave.

### The Character panel

**Window → Character**. What it changes depends on what's chosen:

- While you're editing, the **selected characters**. With only a caret, it
  sets what you type next.
- With a text layer selected but not being edited, **all of its text**.
- With no text selected, the settings **new text** starts with. The options
  bar shows the font, style and size from the same place.

| Setting | What it does |
| --- | --- |
| Font, Style | The family and its style (weight and italics; a variable font's named instances are styles too). |
| Size | In document pixels. |
| Leading | Baseline to baseline. **Auto leading** makes it 120% of the size. |
| Tracking | Extra space between every character, in thousandths of an em. |
| Kerning | The font's own kerning, on or off. |
| Baseline | Raises (positive) or lowers the characters. |
| Width, Height | Stretches the characters horizontally or vertically. |
| Underline, Strikethrough | Lines through or under the text, in its fills and strokes. |
| Axes | A variable font's axes (weight, width, slant, optical size...), as sliders. |
| OpenType features | Ligatures, contextual alternates, discretionary ligatures, small caps, oldstyle, lining, tabular and proportional figures, slashed zero, fractions, ordinals, superscript and subscript, where the font has them. |
| Language | A language tag (`en`, `tr`, `sr-Latn`...): fonts use it for the right letterforms and features. |

### The Paragraph panel

**Window → Paragraph**. It changes the paragraphs the selection touches,
or all of a selected text layer's.

| Setting | What it does |
| --- | --- |
| Alignment | Left, Centre, Right, **Justify** (the last line to the start) and **Justify all**. On a path, it places the text along it. |
| Indent left, right | In from the box's sides. |
| First line | The first line's extra indent; negative for a hanging indent. |
| Space before, after | Space between paragraphs. |
| Direction | From the text (its first strong character), left to right, or right to left. |
| Composer | **Every-line** weighs the whole paragraph's line breaks together for the most even spacing, as InDesign's and Illustrator's do. **Single-line** fills each line as it goes. |

### Styles

Both panels list the document's **styles**. **New Character Style** and
**New Paragraph Style** make one from what's selected (a paragraph style
takes its character settings too), and apply it. A new style made while one
is applied is **based on** it: change the first, and the second follows,
except where it says otherwise.

Click a style to apply it; **None** takes it off. Settings made directly in
the panels sit on top of a style. **⟳** redefines a style from the
selection, changing everywhere it's used. Double-click a style's name to
rename it. **×** deletes it; text that used it keeps how it looks, and styles
based on it are based on what it was based on.

### Fonts

**Inter**, with its italic, comes with Plexel, and **Noto Sans Arabic** and
**Noto Sans Devanagari** stand in for characters Inter hasn't got. To use
other fonts:

- **Type → Add Fonts…** (or the button in the Character panel) adds
  TrueType and OpenType files (`.ttf`, `.otf`, `.ttc`). They're kept in the
  browser, so they're there next time.
- **Type → Load System Fonts** lists the computer's own fonts, in Chrome and
  Edge, after the browser asks your permission. Each loads when it's first
  used.

When a document's text uses a font Plexel hasn't got, a message names it
and the text is shown in Inter. The text keeps asking for its own font:
add the font, and the text is drawn in it again.

Saving a document **carries the fonts its text uses** inside the `.pxll`
file, where each font's licence allows it to go with an editable document,
so the document opens the same on another computer. The built-in fonts
aren't carried; fonts whose licence forbids it aren't either.

### Paint, outlines and pixels

Properties shows a text layer's **Appearance**, as it does a shape's: fills
and strokes in colours, gradients and patterns, each with its opacity and
blend mode. New text is filled with the foreground colour.

**Type → Create Outlines** (also in Properties) turns the text into a
shape, exactly, with the same fills and strokes; it can't be edited as text
after. **Layer → Rasterize** turns it into pixels. Free Transform, the Move
tool and the arrow keys move, scale and turn text as they do any layer.

## 10. Print colour

Everything a document going to press needs: converting it to the
printer's colour, seeing on screen how it will print, finding what can't
be printed, checking each ink, and keeping spot colours as spot colours.

### Converting

**Document → Mode** converts the document to **RGB Colour**, **CMYK
Colour** or **Grayscale**, in that mode's working space (Colour Settings),
or to **8 Bits/Channel** or **16 Bits/Channel**. **Document → Convert to
Profile…** converts it to any profile you choose, built in or loaded
(**Load Profile…** at the bottom of the list); a profile for another mode
changes the mode too. Choose the **rendering intent** and **black point
compensation** there; Mode uses the ones in Colour Settings.

Converting keeps the colours as nearly as the new space allows and changes
the numbers: every layer's pixels, and every colour the document keeps
elsewhere, at once (fills, strokes, gradients and patterns of shapes and
text, colours in adjustments, filters and layer styles, smart objects'
contents). It's one step in the History. Curves and Levels keep their
master curve but lose their per-channel curves when the mode changes,
because the old channels don't exist in the new mode; a message says so.

Compare **Assign Profile**, which keeps the numbers and changes what they
mean.

| Intent | What it does |
| --- | --- |
| Perceptual | Squeezes the whole range of colours into the new space, keeping how they relate. Good for photographs with colours the press can't reach. |
| Relative Colorimetric | Keeps the colours the new space can hold exactly, and moves the rest to the nearest it can, matching white to white. The usual choice. |
| Saturation | Keeps colours vivid at the cost of accuracy: for charts and diagrams. |
| Absolute Colorimetric | As relative, but keeps the original white too: for proofing one press on another. |

### Working spaces

**Edit → Colour Settings** has the **working spaces**: the RGB, CMYK and
Gray profiles that Document → Mode converts to. Load your printer's CMYK
profile there (Load Profile…) and documents convert and proof against it.
Plexel comes with a **Generic CMYK** ink model, which is plausible but not
any real press; for print, use the printer's own profile.

### Proofing on screen

**View → Proof Setup…** chooses the printing condition to simulate: a
profile, the rendering intent, and black point compensation. A document
starts with the working CMYK space. Then:

- **View → Proof Colours** (Ctrl+Y) shows the document as it would print:
  colours the press can't reach turn into the nearest it can.
- **View → Gamut Warning** (Ctrl+Shift+Y) marks in grey what the condition
  can't print, whether or not you're proofing.

In Proof Setup, **Simulate paper colour** shows the paper's own white
rather than the screen's (with a profile that measures its paper; the
built-in ones have a perfect white), and **Simulate black ink** shows the
ink's black rather than the screen's, so shadows look as flat as they'll
print. Proofing changes only what you see: the document, thumbnails,
exports and saved files are left as they are. Each open document has its
own proof settings.

### Separations

The **Separations** panel (Window → Separations) works on CMYK documents:

- Untick an ink to see the plates without it, or leave one ticked to see
  that plate alone. **All Inks** shows them all again.
- Point at the canvas to read each ink under the pointer, and their
  **total**, which turns red when it's over the limit.
- **Total ink limit** is the most ink the paper takes (ask your printer:
  usually 300–340% on coated paper, less on uncoated and newsprint). **Mark
  coverage over the limit on the canvas** shows where it's exceeded, in
  green.

### Document swatches and spot colours

The **Swatches** panel lists the document's own swatches above the colours
kept in the browser. They're saved in the document. **New Swatch** keeps
the foreground colour; **New Spot** makes a spot colour of it. Click a
swatch's name for its options:

| Kind | What it is |
| --- | --- |
| Process | A colour to pick from. Nothing stays linked to it. |
| Global process | Fills and strokes given it stay linked: change the swatch, and they all change. |
| Spot | A named ink (a Pantone colour, a varnish, a house colour), linked like a global one. On screen and in raster output it's drawn through the colour you gave it, its process equivalent. |

The swatch's **Colour** chip changes its colour (its picker can take the
foreground); everything linked to it follows. **Delete** removes it; fills and strokes linked to it
keep their colour. A swatch keeps its own space: a CMYK or Lab spot colour
stays those numbers through any conversion, and fills linked to it are
made again from it in the new mode.

To link a fill or stroke, select the shape or text and choose the swatch
under **Swatch** in its paint in Properties. **Tint** sets how much of the
colour: for a spot colour, the percentage of the ink. Choose **None** to
give it a colour of its own again.

**Load Library…** adds the colours of an Adobe Swatch Exchange file
(`.ase`, from Photoshop, Illustrator, InDesign or Affinity); **Save
Library…** writes the document's swatches as one. ASE files don't name
profiles, so their CMYK, RGB and Gray colours are read in your working
spaces.

### Colour adjustments in CMYK

On a CMYK document, Hue/Saturation, Vibrance, Colour Balance, Black &
White, Channel Mixer, Gradient Map and Threshold work on the colours as the
document's profile defines them, and keep black ink where it was: they
change cyan, magenta and yellow only. An adjustment that changes nothing
leaves the inks exactly as they were. Levels and Curves work on each ink,
as in Photoshop.

## 11. Other apps' files

Photoshop documents open with their layers and go back out with them, SVG
comes and goes as shapes, and PDF goes to print with its vectors, its CMYK
and its spot colours. Whatever a format can't hold is named in the message
that follows the open or the export: open **Details** on it to see the
list.

### Opening

**File → Open** (Ctrl+O) opens Photoshop documents (`.psd`, and `.psb` for
large ones), SVG files and images. A file is known by what's inside it, so
a Photoshop document opens whatever it's called. Fonts its text asks for
are looked for among Plexel's, the ones you've loaded and, where the
browser allows, the computer's. Text whose font isn't here is shown in
Inter and keeps asking for its own, as any text does (chapter 9): add the
font and it's drawn in it.

### Photoshop documents

| What | Comes in as |
| --- | --- |
| Layers and groups | Layers and groups, with their blend mode (pass-through groups stay so), opacity and fill, visibility, locks and colour tag |
| Clipping masks | Clipped layers, as children of the layer they're clipped to |
| Layer masks and vector masks | Pixel and vector masks, with their density and feather |
| Shape layers, solid colour and gradient fills | Live shapes with their fill and stroke |
| Type layers | Live text in its fonts: size, leading, tracking, alignment, and its frame for paragraph text |
| Adjustment layers | Plexel's own: Levels, Curves, Brightness/Contrast, Exposure, Invert, Posterize, Threshold, Hue/Saturation, Vibrance, Colour Balance, Black & White, Channel Mixer, Gradient Map |
| Layer styles | Layer effects, those switched on |
| Embedded smart objects | Smart objects, their contents openable, with their transform |
| RGB, Gray, CMYK at 8 or 16 bits | The same mode and depth, with the document's profile |

What doesn't come over yet, and is named when it happens: Photoshop's
patterns (they're images; Plexel's patterns are made, not pictures), so
pattern fill layers come in as their pixels and Pattern Overlay with one of
Plexel's patterns; Hue/Saturation's settings for single colour ranges;
Selective Colour, Photo Filter and Colour Lookup; smart filters; linked
smart objects whose file isn't inside the document; warped text and text
on a path (as their pixels); colour per character. Alpha and spot channels
come in as channels (chapter 20), named and coloured as the file has them.
32-bit documents open at 16 bits, Lab and indexed documents as RGB,
duotones, bitmaps and multichannel documents as Gray.

### Exporting

**File → Export** (Ctrl+Alt+Shift+W) has four formats that keep layers or
vectors:

- **Photoshop (PSD)** and **Photoshop Large Document (PSB)**: everything
  Plexel and Photoshop share goes over as Photoshop's own: layers, groups,
  masks, shapes as shape layers, text as type layers, adjustments, layer
  effects, smart objects with their contents inside the file, and the
  document's mode, depth, profile and resolution. A flattened composite
  goes in too, for apps that only show the picture. Use PSB for documents
  past 30,000 pixels a side.
- **SVG**: shapes and text as vectors, in sRGB (SVG has no other colour).
  Layers with effects, pixel masks or pixels go in as pictures inside it,
  and an adjustment layer flattens everything under it into one picture,
  since SVG can't adjust. Tick **Text as outlines** for exact letter shapes
  that look the same wherever the file is opened, but are no longer text.
- **PDF**: for print. One page, the document's size, in its own colour
  profile. Shapes are vectors and text is outlines. A CMYK document is
  marked for PDF/X-4 with its profile as the printing condition, and fills
  and strokes linked to a spot swatch print on their own plate, named for
  the swatch. Blend modes PDF doesn't have (Linear Burn and the like)
  flatten what's under them into a picture.
- **EPS**: Encapsulated PostScript, for print tools and workflows that
  still ask for it. The document's size, its colours as the printer's
  device takes them (CMYK as ink; EPS has no colour profiles), spot colours
  and spot channels on their own plates. PostScript has no transparency,
  so everything up to the topmost layer with pixels, opacity below 100%, a
  blend mode or effects is one picture (its see-through parts left
  unpainted); fully opaque shapes and text above that are vectors, text as
  outlines. For the most vectors, keep shapes and text at the top at full
  opacity, or use PDF, which holds transparency.

| Kept as | PSD | SVG | PDF | EPS |
| --- | --- | --- | --- | --- |
| Layers and groups | Yes | Groups | Transparency groups | Opaque groups of shapes; the rest one picture |
| Shapes | Shape layers | Paths | Paths | Paths, when opaque and above any picture |
| Text | Type layers | Text, or outlines | Outlines | Outlines |
| Adjustments and effects | Yes | Pictures | Pictures | One picture |
| CMYK | Yes | Converted to sRGB | Yes, with an output intent | Yes, as device CMYK |
| Spot colours | As their process colours | As their process colours | Their own plates |
| Alpha and spot channels | Yes | Left out | Spot channels as their own plates; alpha channels left out |

### What's still to come

PDF with live, selectable text and its fonts embedded; bleed beyond the
document's edge; opening PDF and Illustrator files; Photoshop's patterns
and smart filters; TIFF export and Photoshop's layers inside TIFFs.

## 12. Brushes

Photoshop's brush engine: tips of any shape, every section of its Brush
Settings panel, the Mixer Brush and Smudge, and Photoshop's own brush files.

### Brush Settings

**Window → Brush Settings** (F5) shows every setting of the painting tool
in use, section by section, with a stroke drawn by the brush at the top as
you change them. Tick a section's box to turn it on.

| Section | What it does |
| --- | --- |
| Brush Tip Shape | The tip (the round one, the built-in Chalk, Spatter and Dry Bristle, and any you've defined or imported), its size, Flip X and Y, angle and roundness, hardness for the round tip, and spacing. |
| Shape Dynamics | How the size, angle and roundness change from dab to dab: a jitter (random change) for each, a control, and a minimum; Flip X and Flip Y Jitter. |
| Scattering | Dabs thrown off the stroke's line, by up to so many diameters, across it or both ways; how many dabs each step puts down, and that count's jitter. |
| Texture | A paper or pattern the paint sits in: Fine Paper, Canvas, Rough Paper, Burlap, or a pattern from a brush file, at a scale, brightness and contrast, inverted or not, by one of ten modes, as deep as Depth (with its jitter and minimum), over the whole stroke or each tip on its own. |
| Dual Brush | A second tip that cuts into the first: its own tip, size, spacing, scatter and count, combined by one of eight modes. |
| Colour Dynamics | Each tip (or each stroke) a little different: between the foreground and background colours, in hue, saturation and brightness, and more or less saturated (Purity). CMYK and Gray documents vary their own colours. |
| Transfer | Opacity, flow, and the Mixer Brush's wetness and mix, each with a jitter and a control. |
| Brush Pose | Tilt, rotation and pressure to paint with when the pen doesn't give them (or when you'd rather it didn't). |

Under the sections: **Noise** (grain at the soft edges), **Wet Edges** (paint
gathers at the edge of each dab, like watercolour), **Build-up** (an
airbrush: it keeps painting while the pen is held still), **Smoothing** and
**Pulled-string smoothing** (the stroke follows a string pulled behind the
pen, so it's steady and corners stay sharp), and **Protect Texture** (a
preset you choose keeps the texture you have).

**Controls.** A setting with a control follows one of: Off, Fade (from full
to the minimum over so many dabs), Pen Pressure, Pen Tilt, Rotation (the
pen's twist), Direction (the way the stroke is going), Initial Direction
(the way it set off), Speed, Distance or Random. **Curve** shows the curve
the control goes through: drag its points up or down, **More points** and
**Fewer** change how many there are, and **Straight** puts it back.

### Tips of your own

**Edit → Define Brush Preset** makes a tip from the image: what's under the
selection, or the whole canvas without one. Dark is paint and light is
none, as in Photoshop, and transparency is none too. Name it and it's a
preset of yours, under **Defined** in the Brushes panel, and the Brush
takes it. A tip can be any size and shape up to 1,024 pixels a side, and it
stays sharp when painted much smaller.

### Photoshop's brushes

**Edit → Import Brushes**, or **Import** in the Brushes panel, reads
Photoshop's brush files (`.abr`, from Photoshop 7 onwards, and the older
ones too). Each file's brushes become a group in the Brushes panel, named
for the file, with a stroke drawn by each; × on the group's name removes
the lot. The tips come over pixel for pixel, the patterns their textures use
come too, and the settings of every section above come with them, along
with the brush's opacity, flow, blend mode and smoothing from the options
bar.

What doesn't come over is named in the message that follows: erodible and
airbrush tips (which come in round), and a stylus wheel control, which the
browser can't read. A control on the pen's rotation when the stroke began
follows the pen's rotation throughout instead. Imported tips and patterns
are kept in the browser, so they're there next time.

### The Mixer Brush

The **Mixer Brush** shares B with the Brush: B chooses whichever of the two
you had last, and **Shift+B** the other. It paints the way wet paint does:
the brush picks up colour from the canvas as it goes and mixes it with the
paint it's loaded with.

| Setting | What it does |
| --- | --- |
| Load and Clean | Load fills the brush with the foreground colour for the next stroke; Clean empties it. With **Load after each stroke** and **Clean after each stroke** ticked (as they start), every stroke begins fresh. Untick them and the brush keeps what it picked up from one stroke to the next. |
| Combination | Photoshop's useful mixes, from Dry to Very Wet, Heavy Mix: each sets Wet, Load and Mix. |
| Wet | How much paint the brush picks up from the canvas. The wetter, the longer the streaks it pulls. |
| Load | How much paint the brush holds. A light load runs out quickly and the stroke dries. |
| Mix | How much of what's put down is the canvas's paint rather than the brush's. |
| Flow | How much paint each dab puts down. |
| Sample All Layers | Picks paint up from everything you see, not only the selected layer. |

### Smudge

**Smudge** pushes paint along as a finger would: it picks up what's under
the brush where the stroke starts and drags it on, running out as it goes.
**Strength** sets how far it carries; **Finger Painting** starts each stroke
with the foreground colour on the finger; **Sample All Layers** smudges
what you see rather than only the selected layer. Smudge has no key of its
own, as in Photoshop: choose it in the toolbar.

Each Mixer and Smudge stroke is one step in the history, named for the
tool. Both work on CMYK and Gray documents, at 8 and 16 bits, through a
selection and on moved or turned layers.

### What's still to come

The retouching tools (Blur, Sharpen, Dodge, Burn, Sponge, the healing
brushes and Clone Stamp); erodible tips, airbrush tips and bristle tips
that splay under pressure; Photoshop's tool presets (`.tpl`); and a stylus
wheel.

## 13. Cut, copy and paste

Pixels, layers, layer styles and paths, within a document, between
documents, and to and from other apps.

### Copying

**Edit → Copy** (Ctrl+C) copies according to what's selected:

- **With a selection**, the selected layer's pixels under it. Partly
  selected pixels (a feathered edge) are copied partly transparent. A pixel
  layer that's been moved, scaled or turned copies exactly as it is, and
  pastes the same way. A shape, text or a smart object is copied as
  Rasterize would draw it, and a group as it looks. With a layer mask
  chosen (its thumbnail clicked), the mask's grays are copied.
- **With no selection**, the selected layer itself, with its mask, its
  effects, its layer style and anything clipped to it. It pastes back
  live: a shape is still a shape and text is still text.
- **With Direct Selection or the Pen** and points selected, the paths
  those points are on.

**Edit → Copy Merged** (Ctrl+Alt+Shift+C) copies everything you can see
under the selection, all the layers together, or the whole canvas with no
selection.

**Edit → Cut** (Ctrl+X) copies and then takes what it copied away: the
pixels are cleared (a mask is hidden there), the layer is deleted, or the
paths are removed. Only pixels can be cut from under a selection: cutting
from a shape or text copies it and says so. Rasterize it first to cut from
it.

Copying is never a step in the history; cutting is one step, named Cut.

### Pasting

**Edit → Paste** (Ctrl+V) puts what you copied in a new layer above the
selected one, and selects it. Copied pixels make a layer called "Layer 1"
(or the next free number); a copied layer keeps its name. Where it goes:

- **Copied pixels, with a selection**: centred on the selection.
- **Otherwise**, where it was copied from, if that's in view, in this
  document or any other. If it isn't, it goes in the middle of the view.

Pasting pixels drops the selection, as Photoshop does; **Select →
Reselect** brings it back.

**Edit → Paste Special** has the other kinds:

| Command | What it does |
| --- | --- |
| Paste in Place (Ctrl+Shift+V) | Exactly where it was copied from, whatever's in view. |
| Paste Into (Ctrl+Alt+Shift+V) | Centred on the selection, with a layer mask that shows it only inside the selection. |
| Paste Outside | The same, with a mask that shows it only outside the selection. |

Pasting into a document in another colour mode, depth or profile converts
what's pasted, with the intent in **Colour Settings**, as Convert to Profile
does. Swatches the pasted shapes are linked to, and the text styles they
use, come with them.

With no document open, Paste makes one to hold a copy or an image.

### Duplicating

**Layer → Duplicate Layer** copies the selected layer, with all it holds,
just above itself, named "… copy". **Layer via Copy** (Ctrl+J) copies the
selected pixels to a new layer in place, above the layer they came from;
with nothing selected it duplicates the layer. **Layer via Cut** does the
same and clears them from where they were, in one step. Neither touches
the clipboard.

### Layer styles

**Layer → Copy Layer Style** copies the selected layer's effects, and
**Paste Layer Style** puts them on another layer in place of its own. This
clipboard is kept apart from the other, so copying pixels doesn't lose a
style you copied.

### Paths

With **Direct Selection** or **the Pen**, select some points and copy: the
whole paths they're on are copied. Paste with either tool and a shape (or a
vector mask) selected, and the paths are added to it, in place, selected.
Paste with any other tool, and they're a new shape in the Shape tool's
colours.

### Other apps

Whatever you copy goes on the computer's clipboard too, as a picture
(sRGB, with transparency) that other apps can paste. A copied text layer
gives them its words as well, and copied paths an SVG that vector apps
take as paths. Pictures bigger than 64 megapixels stay in Plexel only.

Paste takes what other apps put there:

- **An image** becomes a pixel layer, converted from its own profile (sRGB
  if it has none), in the middle of the view, or of the selection.
- **SVG markup** (copied as text from a vector app or a code editor)
  becomes shapes, text and images, as opening an SVG does.
- **Plain text** becomes a text layer in the middle of the view, in the
  Character panel's settings and the foreground colour.

Ctrl+V and Ctrl+Shift+V read the clipboard without asking. **Edit →
Paste** and the other commands chosen from a menu, and **File → New from
Clipboard**, read it through the browser, which asks once whether Plexel
may. If it's not allowed, they paste Plexel's own last copy, if there is
one.

In a text field (a layer's name, a dialog, the Type tool), the clipboard
keys cut, copy and paste text as usual. So does Ctrl+C with text selected
on the page, in a message say.

**File → New from Clipboard** makes a document the size of what's on the
clipboard, in its colour mode, depth and profile, with it pasted in.

### What's still to come

Copying several layers at once (which waits on selecting several), SVG on
the clipboard for copied shapes, and pasting Plexel's live layers in
another tab or window: there, Paste takes the picture.

## 14. Fills, gradients and more ways to select

Filling with any colour, pattern or gradient, in any blend mode; fill
layers that stay editable; patterns made from your own pixels; filling a
hole from what's round it; and the selection tools for things a rectangle
or a lasso can't easily catch.

### Edit → Fill

**Edit → Fill** (Shift+F5) fills the selected pixel layer, or its mask
when that's chosen, through the selection (with none, the whole canvas).

| Contents | What it fills with |
| --- | --- |
| Foreground Colour, Background Colour | The colour, converted into the document's space. |
| Colour… | A colour of your own: the swatch takes the foreground when you click it. |
| Pattern | One of the document's patterns (see below), at a scale. |
| Content-Aware | What's round the selection, continued into it (see below). |
| Black, 50% Gray, White | Those. In a CMYK document, black is a rich black. |

**Blending** sets the **Mode** (any of the 27 blend modes but
pass-through), the **Opacity**, and **Preserve Transparency**: with it on,
only pixels that are already there change colour, and transparent ones
stay transparent. On a mask, colours fill as their grays.

Alt+Backspace and Ctrl+Backspace are still the quick way to fill with the
two colours in Normal at full strength.

### Content-aware fill

Select what shouldn't be there (a little generously, with its shadow),
then **Edit → Fill** with **Content-Aware**. Plexel searches the layer
round the selection for patches that fit, coarse to fine, and builds the
selected area out of them, so textures, edges and stripes run on through
it. It works on the selected pixel layer's own pixels; a layer that's
been scaled or turned has to be rasterized first. It takes a moment on a
big selection, and the canvas keeps working meanwhile. The blend mode,
opacity and Preserve Transparency apply to what it makes.

**Long jobs** (content-aware fill, opening a large Photoshop file, a filter
applied for good) show a bar at the foot of the canvas: what's working, how
far it's got, and **Cancel**. **Esc** cancels too; nothing is changed.

### The Gradient tool

**The Gradient tool** (G) draws a gradient from where you press to where
you let go. Shift keeps the line to steps of 45°. In the options bar:

- **Gradient**: Foreground to Background, Foreground to Transparent,
  Background to Foreground, Black and White either way, or Foreground,
  Background, Foreground. They're made from the colours when you drag.
- **Style**: Linear, Radial (from the start out to the end), Angular
  (round the start), Reflected (both ways from the start) and Diamond.
  **Reverse** swaps the ends.
- **Makes**: a **Fill layer**, or **Pixels**.
- **Mode** and **Opacity**.

Making a fill layer is the default: the gradient becomes a new gradient
fill layer above the selected layer, masked by the selection if there is
one, and it stays editable. **Drag again on a gradient fill layer** (or
on a shape whose top fill is a gradient) and the drag moves that
gradient's ends instead of making a new one; its colours and style are
kept, and Properties edits the rest. **Fit to the Box** in Properties
puts a shape's gradient back across its box.

Set to **Pixels**, the drag lays the gradient into the selected layer's
pixels (or its mask: black to white there is the usual way to fade a layer
out), through the selection, in the mode and opacity chosen.

### Fill layers

**Layer → New Fill Layer → Solid Colour, Gradient** or **Pattern** adds a
layer that's just a paint: it covers the whole canvas (and past it, if
the canvas grows), and its mask shapes it. A new one takes the foreground
colour, a gradient from foreground to background, or the document's first
pattern; with a selection, it's masked by the selection. Choose the layer
and **Properties** edits its paint, as a shape's fill is edited: switch it
between a colour, a gradient and a pattern, change the stops, the angle
and scale, or the pattern. A fill layer moves and transforms like any
layer, and **Rasterize** makes it pixels over the canvas.

Photoshop's Solid Colour and Gradient fill layers open as fill layers.
Exported to PSD, SVG or PDF, a fill layer is written as a shape covering
the canvas, which looks the same.

### Patterns

**Edit → Define Pattern** turns what's visible inside the selection's
bounds (or the whole canvas, with no selection) into a pattern, named in
the dialog. A pattern can be up to 1,024 pixels a side. Patterns belong to
the document: they're saved with it, converted when its colour mode
changes, and come along with layers that use them when they're copied
into another document. The **Patterns** panel (Window → Patterns) lists
them; double-click a name to rename one, and × deletes it (anything
painted with it then draws nothing until it's back).

A pattern can be used by Edit → Fill, a pattern fill layer, the Paint
Bucket, and any shape's fill or stroke (choose Pattern as its paint, then
the pattern). Its **Scale** is 100% at one of its pixels to one of the
document's. Patterns repeat from the document's top-left corner, and stay
smooth when drawn small.

### The Paint Bucket

**The Paint Bucket** (G again, or Shift+G from the Gradient) fills the
pixels like the one you click, as the Magic Wand would select them, with
the foreground colour or a pattern, inside the selection if there is
one. The options bar has the fill, the mode, the opacity, the
**Tolerance** (how far a colour may be from the one clicked, 0 to 255),
**Anti-alias**, **Contiguous** (only pixels joined to the one clicked) and
**All layers** (compare what you see, not just the selected layer).

### Quick Selection

**Quick Selection** (W; Shift+W goes on to the Magic Wand) is a brush:
paint over part of something and the selection grows out to its edges as
you go, found from the colours under the stroke and the edges round it.
Paint more to add; hold **Alt** and paint to take away what shouldn't be
selected. Each stroke is one step. Strokes after the first add to it, as
Photoshop's do, as long as the selection is still the one Quick Selection
made; once something else changes the selection, a stroke starts afresh. [ and ] change the brush's size; **Sample all layers** looks at the
whole image rather than the selected layer; **Auto-Enhance** smooths and
softens the edge.

### The Magnetic Lasso

Choose the **Lasso** (L) and **Magnetic** in the options bar. Click once
on the edge of what you want, then move along it without holding the
button: the outline follows the strongest edge near the pointer, and
points drop by themselves where it has settled. Click to drop a point
yourself (it lands on the nearest edge), for corners or where the edge is
faint; **Alt-click** for a straight side to the point clicked, and
**Backspace** takes the last point back. Click the first point, double-click or press **Enter** to close
it; **Esc** cancels. In the options bar, **Width** is how far from the
pointer an edge is looked for, **Contrast** how strong an edge must be to
be followed, and **Frequency** how often points drop.

### Colour Range

**Select → Colour Range** selects by colour across the whole image (or
the selected layer, with Sample all layers off). It opens beside the
canvas, and the canvas shows the result as you go.

- **Sampled Colours**: click the canvas to sample a colour (Shift-click to
  add more). **Fuzziness** is how different a colour may be and still be
  selected: fully within half of it, fading to nothing at it.
- **Reds, Yellows, Greens, Cyans, Blues, Magentas**: by hue, more for
  stronger colours. **Highlights, Midtones, Shadows**: by lightness.
  **Skin Tones**: warm, moderate colours.

**Invert** selects the rest, and **Selection** says whether the result
replaces the selection or is added to, taken from or intersected with it.

### Growing, bordering and smoothing

- **Select → Grow** adds the pixels touching the selection whose colours
  are within the Magic Wand's tolerance of the selection's own colours.
  **Select → Similar** adds them from anywhere in the image.
- **Select → Modify → Border** replaces the selection with a band of the
  width given along its edge. **Smooth** rounds off corners and
  stair-steps, keeping the edge crisp.

### Transform Selection

**Select → Transform Selection** puts Free Transform's handles on the
selection's outline: drag a corner or an edge to scale (Shift: freely,
Alt: from the middle, Ctrl on an edge: skew), inside to move, outside to
turn. **Enter** makes the selection again through the transform; **Esc**
leaves it as it was. The pixels don't move: only the selection does.

### Select and Mask, refining the edge

**Select and Mask** (Ctrl+Alt+R) now works the edge out again from the
image itself, for hair, fur and soft edges a selection tool can't follow:

- **Radius**: how far either side of the edge to look again. Every pixel
  in that band is judged by its colour between the nearest clear
  foreground and background, so a strand of hair comes out partly
  selected, as it should.
- **Smart Radius** narrows the band where the edge is crisp and widens it
  where it's soft or busy.
- **Refine Edge brush**: turn it on and paint over the canvas where the
  edge needs working out (round hair, say); **Brush size** sets its width,
  and the strokes can be cleared.

Then Smooth, Feather, Contrast and Shift Edge, as before. **Output to**
puts the result in the **Selection**, a **Layer Mask** on the selected
layer, or a **New Layer** with the selected pixels. The dialog sits beside
the canvas, so the brush can reach it.

### Alpha channels

A selection can be kept for later in an **alpha channel**. **Select →
Save Selection** makes a new channel (named Alpha 1, Alpha 2...) or puts
the selection into one you choose, replacing it or adding to, taking from
or intersecting with what's there. **Select → Load Selection** makes a
channel the selection again, inverted or not, or combines it with the
selection there is.

The **Channels** panel lists them, and they can be painted and filled
like a mask: see chapter 20. Channels are saved in the file, and Crop and
Canvas Size move them with everything else.

### What's still to come

Patterns from pixels in Pattern Overlay (a layer style's patterns are
still the four drawn ones), a gradient editor with presets of your own,
Photoshop's patterns, Decontaminate Colours, and Select Subject, which
needs a model.

## 15. Help as you work, and the workspace

### Tooltips

Rest the pointer on a tool in the toolbar for its card: its name and key,
what it does, and every key and gesture it answers to, such as **Shift**
adds to the selection, or **Alt and a right-drag** sizes the brush. Keys
marked *while dragging* matter once the press has started. Once a card is
showing, the next tool's shows at once.

An **ⓘ** beside a setting's name explains it: rest the pointer on it. Panels
and dialogs keep their explanations there rather than in sentences under
each field, and a dialog's ⓘ by its title says what the dialog does.

A greyed-out menu item says why it's greyed out: "Needs a selection: draw
one with a selection tool", "Select a layer first", "Works on a pixel layer,
not a text layer". In the command palette (Ctrl+K), a command that matches
what you type but can't run now is listed after the ones that can, greyed,
with the same reason.

### Holding a tool's key

Tap a tool's key and the tool changes, as always. **Hold** it instead and
the tool is yours only while the key is down: let go and the one you had
comes back. Hold **V** to nudge a layer while painting, **I** to pick a
colour, **M** to draw a quick selection, and carry on with the Brush.

A key held for more than a quarter of a second, or used on the canvas
however quickly, counts as held. Let go in the middle of a drag and the
drag finishes first. While a key is held, the status bar's first hint says
which tool letting go brings back. Choosing a tool on the toolbar meanwhile
keeps that one. Space for the Hand has always worked this way.

Edit → Interface → **Hold a tool's key to use it for a moment** turns this
off, so a held key switches for good like a tap.

### Key hints

The status bar says what each key does with the tool in use, right now:

- Before you press, the tool's keys: with the Marquee, **Shift** adds to the
  selection, **Alt** subtracts, both intersect.
- During a drag, the keys that change the drag: **Shift** for a square or
  circle, **Alt** from the centre.
- While a Free Transform, a crop, a polygon, a path or text is open, its
  keys: **Enter** commits, **Esc** cancels.

Holding a modifier lights up its hints, so you can see what letting go
would change.

### The context menu

Right-click the canvas for what can be done there now: with a selection,
Deselect, Inverse, Feather, Select and Mask, Fill, Layer via Copy and a mask
from the selection; for the selected layer, Free Transform, Duplicate,
Rename, Layer Style, clipping and what suits its kind (Convert to Path for a
shape, Create Outlines for text, Edit Contents for a smart object); then
Undo, Paste, Fit on Screen and 100%. While a transform or crop is open it
offers Commit and Cancel. Only what can run is listed. ↑ and ↓ move, Enter
chooses, Esc closes.

### Workspaces

A workspace is a set of panels for a kind of work. Pick one with the
switcher at the right of the menu bar, or **Window → Workspace**:

| Workspace | Panels |
| --- | --- |
| Essentials | Properties, Colour, Layers. Where a new browser starts. |
| Painting | Colour, Swatches, Brushes, Brush Settings, Layers. |
| Photo | Properties, Colour, Layers, Channels, History. |
| Vector | Properties, Colour, Swatches, Layers, Patterns. |
| Type | Properties, Character, Paragraph, Layers. |
| Print | Colour, Swatches, Separations, Layers. |

Each workspace remembers how you leave it: open a panel in Painting,
switch to Photo and back, and it's still open in Painting. **Window →
Workspace → Reset** puts the one in use back as it was designed.

### Arranging the panels

Panels sit in **groups**. A group shows one panel at a time, with a tab for
each along its top; click a tab to bring it to the front, or the front tab
to fold the group. Drag a tab to move that panel, or the empty part of the
bar to move the whole group. While you drag, a blue outline or line shows
where it will go:

| Let go | What happens |
| --- | --- |
| On another group's tabs | It joins that group as a tab, in front. |
| On its own group's tabs | The tabs change places. |
| Over the top or bottom half of a group | A group of its own, above or below that one. |
| Against a column's side | A new column there. |
| Against the window's left or right edge, with no dock there | A new dock on that side. |
| Anywhere else, over the canvas | It floats in a window of its own. |

Hold **Ctrl** while dragging to float the panel wherever you let go, and
press **Esc** to call the drag off.

**Floating windows** move by their tab bar, and resize by their bottom right
corner (double-click the corner to fit the window to what's in it). Drag a
floating window's bar to a dock to dock it again.

**A column's height is shared.** The groups in a docked column fit it:
each takes the height of what's in it while there's room (the last one
the rest), and when there isn't, the tallest give up room first, so a
short panel such as Layers with a few layers stays whole while a long one
such as Properties scrolls what's in it. The column itself never scrolls
as well, and a tab bar is never covered: every group keeps its tab bar
and a strip of what's in it. Drag the **divider** under a group to trade
height with the group below; from then on the column's groups keep those
proportions as the window changes size. Double-click a divider to fit them
to what's in them again.

**Tabs that don't fit** a group's bar go into a **»** menu at its end;
choose one there to bring it to the front. The front tab always stays on
the bar.

Each group's **⋯** menu does the same from the keyboard: **Float in a
Window**, **Dock on the Left**, **Dock on the Right**, **Collapse to Icons**
(or **Expand Panels**), **Close** and **Close Tab Group**. A panel you close
and open again comes back where it was: in its group, above or below the
group beside it, or in its own window.

**Columns folded to icons.** Each column has a thin strip along its top;
its double arrow (or a double-click on the strip) folds the column to a
narrow row of icons, a button a panel, grouped as the tabs were, and the
canvas takes the room. Click an icon to show its panel beside the column,
over the canvas; click it again, press **Esc**, or click anywhere else, and
it goes back. **Window** shows a folded panel the same way. Drag an icon to
move its panel, as you would a tab. The arrow at the top opens the column
out again, at the width it had.

**Several groups in one window.** Let go of a panel or group over the
**foot** of a group in a floating window (the bottom fifth or so; the blue
line shows it) and it stacks under that group, in the same window, as in a
column. A window with more than one group has a dotted **grip** along its
top: drag it to move the whole window, or to a dock to dock every group in
it, in order (onto a group's tabs, they all join it as tabs). Each group's
own bar drags just that group out.

### Numbers, sliders and choices

- **A slider is one bar**: its name at the left, its value at the right,
  filled to the value. Press anywhere on the bar to set the value there
  and drag; click the value to type one.
- **Drag a number's name sideways** to change it (a slider's, a box
  field's X or W, the options bar's Size, a dialog's Width or Radius):
  **Shift** goes ten times as fast, **Alt** ten times as slow.
- **In a number**, the up and down arrow keys step it (**Shift** ten steps,
  **Alt** a tenth of one); **Enter** or clicking away keeps what you typed,
  **Esc** puts the value back.
- **A few choices side by side** (a stroke's Align, Corners and Ends, a
  shape's corner style, Knockout, the paint's kind) are buttons, one
  pressed; the arrow keys move between them.
- **A dot before a setting's name** means it's set to something other than
  its default (an opacity under 100%, a blur's radius changed).
  **Double-click the name** to put the default back.

### Your toolbar

**Edit → Toolbar…** (or right-click the toolbar's empty part, or choose
**Edit Toolbar…** under its **…** slot) arranges the toolbar, as
Photoshop's Edit Toolbar does. Drag a slot by its grip, or use its arrows,
to move it; untick it to take it off the bar. Tools taken off are under the
**…** slot at the foot of the bar, and their keys still work. **Columns**:
one, two, or **Auto** (two when the window is too short for one). **Restore
Defaults** puts the toolbar back as Plexel ships it. It's kept by your
browser.

### Your own workspaces

Arrange the panels as you like them, then choose **Window → Workspace → New
Workspace…** and give it a name. It joins the list in Window → Workspace and
the switcher, and remembers how you leave it like the others. **Reset**
brings it back as you saved it, and **Save Changes to** (its name) makes
how it is now the way it's saved. A new workspace with the name of one of
yours replaces it; the task workspaces' names are taken. **Rename and Delete
Workspaces…** renames yours and deletes them; deleting the one in use
changes to Essentials. Your workspaces are kept by your browser.

**Workspaces as files.** **Window → Workspace → Export** (its name)
saves the workspace in use as a file (`Name.plexel-workspace.json`): which
panels are open, how they're grouped, docked, folded and sized, the
floating windows, and your keyboard shortcuts if you've changed any.
**Import Workspace…** reads one back, in another browser or on another
computer: give it a name (the file's to start with; one of yours by the
same name is replaced), and tick **Use its keyboard shortcuts** to take its
keys in place of yours. It's ticked to start with when you haven't changed
any. A panel this version of Plexel doesn't have is left out.

### Your own keyboard shortcuts

**Edit → Keyboard Shortcuts…** (Ctrl+Alt+Shift+K, as in Photoshop, or
Ctrl+/) lists every command with its keys, by menu. Type in the box at the
top to find a command by its name or a key by what it's called (`ctrl+j`).

- Click **+** beside a command, then press the key you want, with any of
  Ctrl, Alt and Shift. **Esc** stops listening.
- Click one of a command's keys, then press another, to change that key.
- Click **×** on a key to take it away.
- If another command has the key, Plexel says whose it is and asks; **Use
  it here** takes it from that command.
- The arrow at the end of a changed command's row (marked with a dot) puts
  its keys back as Plexel ships them; **Reset All** puts every one back.
- **Set** starts from another app's keys: **Photoshop** (Plexel's own),
  **Affinity** (Affinity Photo's, which follow Photoshop's for the tools
  and commands Plexel has, so they're the same keys) or **Illustrator**
  (its tools: the Paintbrush on B, the Blob Brush on Shift+B, the Pencil on
  N, the Shape tool on M, the Shape Builder on Shift+M, the Live Paint
  Bucket on K, the Lasso on Q, the Magic Wand on Y, the Width tool on
  Shift+W, the Eraser on Shift+E, Rotate View on Shift+H, Free Transform on
  E; and Create Outlines on Ctrl+Shift+O, Show or Hide Layer on Ctrl+3,
  Swap Colours on Shift+X too). Change any of them after; the menu then
  says **Your own**.

Nothing changes until you press **Save**; **Cancel** forgets it all. Some
keys can't be given to anything: those the browser keeps for itself (Ctrl+W,
Ctrl+T, Ctrl+N, Ctrl+Tab, F11 and the like, which never reach the page),
the developer tools' (F12, Ctrl+Shift+I, J and C), and Ctrl+C, X and V,
which stay Cut, Copy and Paste so the clipboard works with other apps. Tab
stays hiding the panels. The menus, the palette, the tool cards and the
toolbar all show your keys. Your keys are kept by your browser, and go
with an exported workspace.

### Screen modes and hiding the panels

- **Tab** hides the toolbar, the options bar, the docks and the floating
  panels, for the canvas alone; Tab again brings them back. **Shift+Tab**
  hides only the docks and the floating panels.
  When a control has the focus (a field, a button), Tab moves the focus as
  usual; click the canvas first.
- **F** steps through the screen modes (also in **View → Screen Mode**):
  - **Standard**: everything.
  - **Full Screen Mode with Menu Bar**: no document tabs or status bar.
  - **Full Screen Mode**: the canvas alone, filling the screen. Tab brings
    the panels back over it; the menus are in the command palette (Ctrl+K)
    and the context menu. F once more goes back to Standard.

A note at the top of the canvas says how to get back each time.

### Interface settings

**Edit → Interface** sets how the interface looks and how much it explains.
Changes show at once and are remembered by your browser; **Restore
Defaults** puts them all back.

| Setting | What it does |
| --- | --- |
| Interface size | 80% to 150%: menus, panels, bars and dialogs. The canvas keeps its own zoom. |
| Density | Compact makes rows and bars tighter, for small screens. |
| Contrast | More makes text full strength, edges and rules stronger, and focus rings thicker, over whichever theme is on. |
| Motion | Reduced stops transitions and animations. "As the system says" follows your computer's own setting. |
| Rich tooltips | Off, tools give only their name and key, and greyed-out items say nothing. |
| Key hints in the status bar | Off, the status bar has none. |
| Hold a tool's key to use it for a moment | Off, holding a tool's key switches to it for good, like a tap. |
| Tab hides the panels | Off, Tab only moves the focus between controls. |

## 16. Rulers, guides, grids and snapping

### Rulers

**View → Rulers** (Ctrl+R) shows rulers along the canvas's top and left.
They measure from the *zero point*, the document's top-left corner to
start with, in the units of **View → Ruler Units** (or right-click a
ruler): pixels, inches, centimetres, millimetres or points. A mark on each
follows the pointer. With the view turned a quarter, each ruler measures
whichever side of the document runs along it; at other angles they're
blank.

Drag from the box where the rulers meet to move the zero point: the
rulers, the grid and the readouts then measure from there. Double-click
the box to put it back. The zero point belongs to the open document and
isn't saved with it.

### Guides

Guides are lines across the canvas that things snap to. They're saved with
the document (and in Photoshop files), and adding, moving and removing
them are steps in the history.

- **Drag out of a ruler** for a guide parallel to it: out of the top
  ruler a horizontal one, out of the left a vertical one. Hold Alt for the
  other kind. While you drag, a readout by the pointer says where it is;
  it lands on whole pixels, snaps to layers' edges and the canvas's, and
  with Shift held to whole ruler units.
- **With the Move tool**, the pointer over a guide becomes a double arrow:
  drag the guide somewhere else, or off the canvas (onto a ruler) to
  remove it.
- **View → New Guide…** places one at a position you type, from the zero
  point.
- **View → New Guide Layout…** makes columns and rows with gutters inside
  margins, as Photoshop's does. Leave a width or height empty to share the
  space out; give one, and the columns are centred. The guides show on the
  canvas as you change the settings.
- **View → New Guides from Shape** puts guides on the selected layer's
  edges and centre.
- **View → Lock Guides** (Ctrl+Alt+;) keeps them from being dragged;
  **View → Clear Guides** removes them all; **View → Show → Guides**
  (Ctrl+;) hides and shows them.

Crop and Canvas Size move the guides with the canvas. Straightened at an
angle, a crop removes the guides that no longer run straight across or
down.

### The grid and the pixel grid

**View → Show → Grid** (Ctrl+') lays a grid over the document, from the
zero point. **Edit → Guides, Grid & Snapping…** sets how far apart its
lines are (in any unit), how many finer lines divide each cell, and its
colour. Zoomed out so far that its lines would crowd together, the finer
lines go first, then the grid.

**View → Show → Pixel Grid** shows the lines between pixels from 600% up.
It's on to start with.

### Snapping

**View → Snap** (Ctrl+Shift+;) turns snapping on and off; **View → Snap
To** chooses what things snap to:

| Snap To | What lines up |
| --- | --- |
| Guides | Guides, while they're shown. |
| Grid | The grid's lines and its finer lines, while it's shown. |
| Layers | Other layers' edges and centres, and the same spacing between them (below). |
| Document Bounds | The canvas's edges and centre. |
| Anchor Points | Shapes' anchor points. |
| Pixels | Whole pixels, for whatever didn't snap to anything else. Off to start with. |

What snaps:

- **The Move tool**: the box round the layers being moved, by its left,
  centre or right, and its top, middle or bottom. Layers with pixels in
  them still move by whole pixels.
- **Free Transform**: the box when dragged from inside, and the handle
  being dragged (but not while skewing).
- **Crop**: its box when dragged, and its handles.
- **The Shape tool**, **the Gradient tool**, **the Type tool**'s point or
  frame, **the Marquee**, the **Polygonal Lasso**'s corners and **the Pen**'s
  new points, where they're placed.
- **Direct Selection**: the anchor you grab, with the others selected
  following it.
- **Guides** being dragged, and the **zero point**.

Hold **Ctrl** while dragging to let go of snapping for as long as it's
held. Things snap within a few pixels on screen, whatever the zoom.

### Smart guides

With **View → Show → Smart Guides** (Ctrl+U) on, a snap shows what it lined
up with: a line in the smart guides' colour from what you're dragging to
the layer, or the canvas, it now lines up with. Dragged between two
layers in a row, a layer also snaps to the middle of the gap between
them, or to the same gap as a pair beside it already has, and the equal
gaps are marked. Off, snapping still works; it just isn't drawn.

While the Move tool drags, a readout by the pointer says how far it has
moved.

### Selecting several layers

In the Layers panel, **Ctrl-click** a layer to add it to those selected,
or take it out; **Shift-click** selects every row from the key layer to
the one clicked. The *key layer* is the one clicked last, shown darker: the
Properties panel shows it, and commands that work on one layer use it.
The Move tool and the arrow keys move every selected layer, and Delete
deletes them all, as one step.

### Align and distribute

**Layer → Align** and **Layer → Distribute**, and the buttons on the Move
tool's options bar, line the selected layers up:

- **Align** Left Edges, Horizontal Centres, Right Edges, Top Edges,
  Vertical Centres or Bottom Edges.
- **Distribute** spreads three or more layers so their edges or centres
  are evenly apart, the outermost staying where they are; **Horizontal
  Spacing** and **Vertical Spacing** make the gaps between them equal.

**Align To** (in the Align menu and on the options bar) says what they
line up with:

| Align To | Lines them up with |
| --- | --- |
| Selected Layers | The box round them all. With one layer selected, the canvas. |
| Key Layer | The key layer, which stays where it is. |
| Canvas | The canvas. Distribute spreads them across it, the outermost against its edges. |
| Selection | The selection's box; Distribute spreads them across it. |

Layers with pixels in them are kept on whole pixels; shapes and text move
exactly. Each Align or Distribute is one step.

### Settings

**Edit → Guides, Grid & Snapping…** has the ruler units, the colours of
guides, smart guides and the grid, the grid's spacing and subdivisions,
and what snapping snaps to. Like the View menu's switches, they're
remembered by your browser; **Restore Defaults** puts them all back.

### What's still to come

- Rotated, coloured and per-guide-locked guides, and guides on artboards.
- Measuring with a Ruler tool, and distances shown between layers as
  smart guides.
- Snapping a path's segments (not only its points) and a layer's visible
  edge rather than its box; snapping text to its baseline.

## 17. Tiled documents

A tiled document is a seamless tile: what goes off one edge comes back at
the other, as if the canvas were wrapped round, so it repeats without a
seam. For textures, patterns, wallpaper and game tiles. Krita calls this
Wrap Around Mode; Photoshop's nearest is Pattern Preview.

### Making a document tiled

**Document → Tiled** chooses how it repeats:

| Choice | Repeats |
| --- | --- |
| Off | Not at all: an ordinary document. |
| Both Directions | Across and down: a texture or pattern. |
| Horizontally | Across only: a frieze or a border. |
| Vertically | Down only. |

It's part of the document: a step in the history (Undo takes it back), and
saved in the `.pxll`. A Photoshop file has no such setting, so a tiled
document exports as the one tile.

### Tiled View

**View → Tiled View** shows the document's copies all round it, so you see
how it repeats while you work. It's on when a document is made tiled;
switch it off for the canvas alone. It's remembered by your browser, like
the grid. The selection's ants, guides, the grid and a tool's handles show
on the document itself, not on the copies.

With Tiled View on, you can work in any copy: a press there acts on the
document, at the same place, and a drag over the edge between copies stays
in one piece.

The document itself is framed in the accent colour, so you can tell it from
its copies. Moved far enough that it's mostly out of view, a **Back to the
document** button appears at the top of the canvas and centres it again
(Ctrl+0 fits it on screen).

### Painting

The Brush, the Eraser, the Mixer Brush and Smudge paint over the edges: a
stroke that leaves one side comes back at the other, without a seam,
whether Tiled View is on or not. The Mixer Brush and Smudge pick paint up
from the other side too. A brush's paper texture only repeats seamlessly
if its size divides the document's.

### Offset

**Filter → Offset…** moves everything on a layer across and down by a
number of pixels, as Photoshop's does. **Undefined areas** says what fills
the gap left at the far side:

- **Wrap around**: what moved off one edge, coming back at the other. Offset
  by half the document's width and height to bring the seams into the
  middle, where you can paint them out; offset by half again to put it back.
- **Repeat edge pixels**: the edge pixels drawn out across the gap.
- **Set to transparent**: nothing.

Like the other filters it can stay live, in the layer's effects (change it
in Properties, or turn it off), or be applied to a pixel layer's pixels
for good. It works on the canvas: what it gives is the canvas only.
Applied for good, it needs a layer that isn't turned or scaled; keep it
live otherwise.

### A tile as a pattern

**Edit → Define Pattern…** in a tiled document takes the whole canvas,
edges and all (even where they're transparent), so the pattern repeats
exactly as the document does. Untick **The whole canvas** for what's
visible trimmed to its edges, as before.

### Layers over the edges

Everything on a tiled document is on the torus. A shape, text, a smart
object, or a pixel layer moved or transformed so that it crosses an edge
shows at the other side too, all of it still live: move it, edit it,
transform it. Live filters read across the edges, so a blur over the seam
is one blur, not two halves with a line between; layer styles do too, so a
drop shadow or a stroke carries on round. Layers clipped to one, and a
layer's own masks, go with it.

A pixel layer's pixels wrap from the rectangle the canvas covers in the
layer's own pixels, where they were made. A layer moved away from where it
was painted carries those pixels round; pixels painted on it after it was
moved, out past that rectangle, don't wrap.

### Selections, fills and gradients

- **The Marquee and the Lassos**: a shape dragged over an edge selects the
  part past it at the other side. The Polygonal and Magnetic Lassos keep
  their corners in one piece over a seam. The Magnetic Lasso can't cling
  to edges across the seam too.
- **The Magic Wand, Grow and Similar, Quick Selection and the Paint
  Bucket** flow round the edges: like pixels at the right edge touch those
  at the left.
- **Feather, Expand, Contract, Border and Smooth**, and Select and Mask
  (its sliders, its edge detection and its refine brush), treat the edges
  as joined, so there's no soft line at the seam.
  Moving a selection, or Transform Selection, carries it round.
- **Gradients** (the Gradient tool's fill layer, and its pixels) run on
  over the seam they're dragged across: each pixel takes the gradient's
  value at its copy nearest the middle of the line (the start, for radial,
  angular and diamond). A gradient must break somewhere on a torus, and
  that puts the break half a period away from where you dragged.

A group's mask, an adjustment layer's and a fill layer's wrap too, and
knockout groups knock out their layers' copies. Offset's result repeats
whatever its edge mode, so a blur after it reads round the seam.

On a huge document, where selection work reads the image at a smaller
size, the Magic Wand, Quick Selection and Select and Mask don't wrap.

## 18. Retouching

Four tools for repairing a picture: removing a mark, a blemish, a wire or
a speck of dust, or copying one part of the image over another. All of
them work on a pixel layer.

### The Clone Stamp (S)

Paints a copy of another part of the image. **Alt-click** where to copy
from (a small cross marks it), then paint where the copy goes: each dab
lays down what's under the source, at the same distance and direction from
the brush. It uses the brush like the Brush does: size, hardness, opacity
and flow, and pressure for size and opacity.

- **Aligned** (on to start with): the distance from your first stroke to
  the source holds for every stroke after it, so strokes anywhere carry on
  copying the same picture. Off, each stroke starts from the source again,
  for repeating one thing in several places.
- **Sample all layers**: copy what the whole image shows, not just the
  selected layer, onto that layer. A new empty layer cloned onto from all
  layers keeps the repair separate from the picture.

### The Healing Brush (J)

Like the Clone Stamp, Alt-click where to take the repair from and paint
over what to repair. When you let go, what you painted is **healed**: it
keeps the source's texture (grain, skin, fabric) but takes on the colour
and brightness round where you painted, so it blends in with no edge. It
works on a layer that hasn't been turned or scaled; rasterize one that has.

### The Spot Healing Brush (J)

No source to set: paint over a spot, a speck or a small mark (it shows as
a gray wash while you paint), and when you let go it's filled in from
what's round it, by the same search content-aware fill uses (chapter 14).
Use a brush a little bigger than the spot.

### Patch (J)

For a larger area. Draw round what to repair as you would with the Lasso
(or select it with any tool first), then drag from inside the selection to
an area with the texture you want, and let go: that area is healed into
the selection, its texture with the colour and tone round the selection.
The selection stays, so you can patch again from somewhere else.

**J** chooses the healing tools; **Shift+J** goes from one to the next. In
a tiled document (chapter 17) the Clone Stamp's and the Healing Brush's
source reads round the edges.

### What's still to come

- Content-Aware Fill's own workspace, Content-Aware Move and the Red Eye
  tool.
- The Spot Healing Brush across a tiled document's seam, and on a huge
  document's whole area at once.
- The source shown under the brush (an overlay) while cloning, and
  rotating or scaling the source.

## 19. Warps: Distort, Perspective, Warp and Liquify

Bending a layer out of its rectangle. Every warp here is **live**: the
layer keeps its own pixels (or its shape, or its text), and the warp is an
effect in its effects list, under it in the Layers panel like a live
filter. Hide it with its eye, change it again, or delete it, at any time.
Warps work on pixel layers, smart objects, shapes and text; to warp a
group, convert it to a smart object first.

### Distort and Perspective

Open Free Transform (Ctrl+Alt+T) and choose **Distort** or
**Perspective** in the options bar, or choose them from
**Edit → Transform**.

- **Distort**: drag a corner anywhere, or the middle of an edge to move
  both its corners together.
- **Perspective**: drag a corner along an edge and the corner at the other
  end of that edge moves the opposite way, as if the layer leaned away;
  drag an edge's middle to lean that edge.
- In the **Free** mode, Ctrl-drag a corner to distort it, and
  Ctrl+Alt+Shift-drag a corner for perspective, as in Photoshop.

Scaling, turning and moving still work in every mode. A corner can't be
dragged past the others, so the shape never folds over itself.

### Warp

Choose **Warp** in the options bar (or **Edit → Transform → Warp**). A
mesh appears over the layer:

- Drag anywhere **on the layer** to pull that part, the mesh bending
  smoothly round it.
- Drag an **anchor** (a square, at a corner of the mesh's cells) to move
  it with its handles, or a **handle** (a diamond) to change the curve
  through its anchor; the handle opposite turns with it, so the curve stays
  smooth.
- **Style** gives a ready-made shape: Arc, Arc Lower, Arc Upper, Arch,
  Bulge, Shell Lower, Shell Upper, Flag, Wave, Fish, Rise, Fisheye,
  Inflate, Squeeze and Twist, with **Bend** and **H** and **V**
  distortion, across the layer or **Vertical**. Dragging the mesh of a
  style makes it **Custom**, a mesh of its own.
- **Grid** splits the mesh into 2 × 2 up to 5 × 5 cells, to bend parts of
  the layer on their own.
- **Reset** takes the warp off.

**Enter** commits, as one step named for what you did (Distort,
Perspective, Warp); **Esc** cancels. Free Transform on a layer that's
already warped picks the warp up where it was left, mesh and all; a style
can also be changed afterwards in **Properties**, with the warp's row
selected in the Layers panel.

Shapes and text with plain colour fills and strokes are warped as
**outlines**, so their edges stay sharp at any zoom; ones with a gradient
or pattern are warped as pixels.

### Liquify (Ctrl+Alt+X)

**Filter → Liquify** turns the canvas into Liquify's brush. Choose a
**Tool** in the options bar, its **Size** and **Pressure**, and brush:

- **Forward Warp** pushes what's under the brush along as you drag.
- **Reconstruct** takes the warp back where you brush; **Restore All**
  takes all of it back.
- **Smooth** evens out the warp where you brush.
- **Twirl** turns what's under the brush clockwise while you hold it
  (Alt: the other way).
- **Pucker** draws it in to the brush's middle while you hold it; **Bloat**
  pushes it out (Alt swaps them).
- **Push Left** moves it to the left of the way you drag.

**Enter** commits the whole session as one Liquify step; **Esc** cancels
it. Liquify again on the same layer carries on with the same warp.

### Notes

- **Layer → Rasterize** on a warped shape, text or smart object makes it a
  pixel layer and keeps the warp, live, where it was.
- Painting on a warped pixel layer paints its own pixels, where they are
  before the warp: the paint shows warped with them.
- **Photoshop**: a smart object's perspective and warp, and warped text,
  come in as the Warp effect and go out as Photoshop's own; a warp of more
  than one cell goes out flat. Liquify, and a warp on anything else, go out
  as the layer's pixels unwarped, with a warning, as live filters do.

### What's still to come

- Puppet Warp, Perspective Warp (planes), and Liquify's freeze mask, face
  tools and pen pressure.
- Warped shapes and text in SVG and PDF as warped outlines (they go out as
  the shape unwarped today, as other live filters do).
- Perspective Crop.

## 20. Channels

A document's **channels** are its colours, one at a time, and whatever it
keeps alongside them: **alpha channels** (selections kept for later) and
**spot channels** (inks printed on plates of their own). The **Channels**
panel (Window → Channels) lists them all: the composite first (RGB, CMYK
or Gray), then each colour channel (Red, Green and Blue; Cyan, Magenta,
Yellow and Black), then the alpha and spot channels, each with an eye and a
thumbnail.

### Showing and picking

A click on a row **picks** that channel: it's what the tools change, and
it's shown alone. One colour channel alone shows in gray, as its own
brightness (a CMYK ink as white where there's none). An alpha or spot
channel picked alone shows in gray too, white where it selects (black
where a spot has ink). **Shift**-click adds a channel to those picked;
click the composite to pick them all again. The **eyes** only show and
hide, without changing what's picked: with Blue hidden, an RGB picture
shows without its blue; with the composite's eye on as well as an alpha
channel's, the channel shows as a tint over the picture.

The keys: **Ctrl+2** the composite, **Ctrl+3** onwards the channels after
it in the panel's order. Picking a layer in the Layers panel picks the
colour channels again, so painting goes back to the layer.

### Painting and filling a channel

With an **alpha or spot channel** picked, the Brush and the Eraser paint
it, and Fill, Delete, the Gradient tool and the Paint Bucket fill it, all
through the selection when there is one. The colours are gray levels:
white selects and black deselects on an alpha channel; on a spot channel
black is full ink and white none, as in Photoshop. The Eraser paints the
background colour. The Magic Wand and the Paint Bucket read the channel
itself, not the layer. Delete with nothing selected fills the whole channel
with the background colour; it never deletes the layer.

With **some colour channels** picked (Red alone, say), painting and
filling change only those: the Brush, Fill, Delete, the Gradient tool, the
Paint Bucket, content-aware fill, and filters and adjustments applied for
good (a filter is applied for good here rather than added live, since a
live one would change every channel). The Eraser paints the background
colour into them, and Delete fills them with it. Nothing changes where the
layer is transparent.

### Alpha channels

**New** (or Document → Channels → New Channel) makes an empty alpha
channel, picked and shown alone, ready to paint. **Save Selection** keeps
the selection as a new one, and **Save Into** puts it into the picked one.
**Ctrl**-click a row (or click the selection button at the foot of the
panel) to load a channel as the selection: Shift adds, Alt takes away, both
intersect.

**Channel Options** (double-click a thumbnail, or Document → Channels →
Channel Options) sets the name, the tint it shows in over the picture
(red by default), its opacity, and whether the tint marks the **masked**
areas (the default) or the **selected** ones.

### Spot channels

**New Spot…** (Document → Channels → New Spot Channel) makes a spot
channel: a name (the ink's), its colour (the foreground, one of the
document's spot swatches, whose name it takes, or a colour picked there)
and its **solidity**, which is only how it looks: 0% shows the ink as
see-through, multiplied over what's under it; 100% as opaque. With a
selection, the new channel starts filled where the selection is.

Spot channels show over the picture as their ink, and in the Separations
panel as inks of their own, with their readings under the pointer counted
in the total. In a PDF each is printed on its own plate, sharing its plate
with spot-coloured shapes of the same ink; in a PSD each is a spot channel.
Channel Options changes a spot's ink and solidity, or makes it an alpha
channel (or an alpha a spot).

### Loading colour channels

**Ctrl**-click a colour channel to load it as the selection by its
brightness (a CMYK ink selects where there's none of it), and the
composite (or **Select → Load Luminosity**, **Ctrl+Alt+2**) to load the
picture's luminosity. Transparent parts count as white.

### In files

Alpha and spot channels are saved in Plexel's own files with how they
show. PSD and PSB files bring theirs in, named and coloured as Photoshop
had them, and Plexel writes them back the same way.

### What's still to come

- Filters and adjustments on an alpha or spot channel (Gaussian Blur on
  an alpha channel, say), and Image → Calculations and Apply Image.
- Split Channels, Merge Channels and Merge Spot Channel.
- The Smudge, Mixer, Clone and healing tools on an alpha or spot channel.
- Showing more than four alpha and spot channels on the canvas at once.

## 21. Artboards and symbols

### Artboards

An **artboard** is a page of the document with its own size: a phone
screen and a tablet screen side by side, a set of social posts, the pages
of a leaflet. Each is exported on its own, as in Photoshop, Illustrator
and Affinity.

- **Start with one**: tick **Artboard** in File → New. The document starts
  as an artboard the size you asked for, with an empty layer on it, on a
  *pasteboard* round it.
- **Layer → Artboards → New Artboard** adds one the size of the last, to the
  right of the others. In a document without artboards, the first turns the
  canvas into Artboard 1, every layer on it.
- **Layer → Artboards → Artboard from Layers** puts the selected layers on a
  new artboard the size of the box round them.
- **The Artboard tool** (V, with Move; Shift+V goes between them): drag on
  the pasteboard to draw an artboard; drag one to move it, its layers with
  it (Shift keeps it straight); drag the handles of the selected one to size
  it, its layers staying where they are. The options bar sets its size, by
  number or from presets (phones, tablets, the web, social posts, pages), and
  **Add Artboard** adds one beside it.
- **Its name**, over its top left corner, selects it when clicked, moves it
  when dragged (with any tool) and renames it when double-clicked.

In the Layers panel an artboard is a group, its layers inside it. A layer
you draw on an artboard goes onto it, even when a layer on another one is
selected; one you drag onto another artboard with the Move tool goes onto
that one, and dragged off every artboard, it goes to the top level.

**Properties** for an artboard: its place and size (drag the letters to
scrub them), a preset size, Portrait / Landscape, its **Background**
(white, black, none or a colour of your own) and **Clip contents**: on, its
layers show only inside it, as in Photoshop; off, they run over its edge
onto the pasteboard (exporting still crops to it). **Layer → Artboards →
Release Artboard** lets its layers go to the top level and takes the
artboard away.

The canvas is the pasteboard round the artboards, shaded dark, and grows
to keep them on it; layers can sit on the pasteboard too, outside every
artboard.

**Exporting**: with artboards, File → Export offers **All artboards** (each
a file of its own, cropped to it, together in a zip), **Selected** (the
artboard the selection is on) or the **Whole canvas**, in every format.

### Symbols

A **symbol** is artwork kept once and placed as **instances**: a logo, an
icon, a button. Edit the symbol and every instance follows. Each instance
keeps its own place, size, turn, opacity and blend mode.

- **Layer → Symbols → New Symbol** (**F8**, as in Illustrator) makes the
  selected layers a symbol, with an instance where they were.
- **The Symbols panel** (Window → Symbols) lists the document's symbols,
  each with a picture and how many instances it has. Click a symbol's
  picture to place an instance in the middle of the view, or drag it onto
  the canvas. Rename one by double-clicking its name; Duplicate and Delete
  are on its row (deleting a symbol makes its instances groups of their own).
- **Edit Symbol** (double-click a symbol in the panel, its edit button,
  Layer → Symbols → Edit Symbol, or the button in an instance's Properties)
  opens it in a tab of its own, with every tool. What you do there shows in
  every instance at once, and is one step in the document's history (undo
  it there and the tab follows). Close the tab when you're done; there's
  nothing to save.
- With an instance selected, Properties and the panel **Replace** the symbol
  it shows, and **Break Link** (also in Layer → Symbols) makes it a group of
  its own that no longer follows the symbol.

Instances are moved, scaled and turned like any layer (Free Transform
works on them), stay sharp at any size, and can be rasterized. Copying an
instance to another document takes its symbol with it. Symbols are saved in
Plexel's files; a PSD, SVG or PDF gets each instance as the layers it shows.

### What's still to come

- Photoshop's artboards in PSD files, read and written as artboards (they're
  written as groups for now), and a multi-page PDF with a page per artboard
  (today each artboard is a PDF of its own in the zip).
- Guides per artboard, and Paste on All Artboards.
- Editing a symbol in place on the canvas, as Illustrator's isolation mode
  does; and Affinity's per-instance changes to a symbol's parts.
- Symbol libraries shared between documents, and 9-slice scaling.


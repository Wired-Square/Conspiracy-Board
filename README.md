# Conspiracy Board

A corkboard for connecting things up: evidence cards pinned to a board, joined
with red string, grouped into clusters, and read chronologically on a timeline.
Emails can be pulled in as first-class cards; images — a photograph, or a
screenshot of a text thread whose words are read back out — become evidence cards.

A macOS app, built with Tauri. Entirely local — no backend, no accounts, no
network; nothing you pin here leaves the machine.

## Running it

```sh
pnpm install
pnpm dev
```

Three things that bite on a fresh machine:

- **pnpm isn't bundled with recent Node.** Recent versions no longer ship
  corepack, so `corepack enable` may not exist. `npm install -g pnpm` works fine.
- **esbuild's build script must be allowed** or Vite won't run. That's already
  declared in `pnpm-workspace.yaml` (`allowBuilds: esbuild: true`); if a future
  dependency needs the same, pnpm will tell you and that's where it goes.
- **A Rust toolchain is required**, since `pnpm dev` builds the shell as well as
  the UI. The first build is slow and every one after it is not.

| Script | What |
|---|---|
| `pnpm dev` | The app. Starts Vite and builds the shell around it |
| `pnpm build` | `Conspiracy.app` and a dmg, under `src-tauri/target/` |
| `pnpm typecheck` | `tsc -b --noEmit` |
| `pnpm test` | Unit tests, in `America/Los_Angeles` — [on purpose](#dates) |
| `pnpm test:utc` | The same tests at UTC |

`pnpm exec vite` will serve the UI, but it will not run: boards are read through
the shell, so `invoke` throws, `init()` never resolves and the app sits on
*Pinning the board…* forever. It fails at the loading screen rather than
degrading, which is worth knowing before you spend ten minutes on why. `pnpm dev`
is the way to run it.

## What's on a board

- **Cards** — the only entity. A card has a title, markdown notes, an optional
  picture, an optional cluster, a position, an optional date, and a *kind*.
- **Kinds** — six of them, in three registers. A kind only ever *adds* to an
  ordinary card, so whatever it is it keeps its position, cluster and
  connections for free. See [Kinds](#kinds).
- **Clusters** — a tag plus a colour plus a visibility toggle. Not a spatial
  group, and **not what a card is** — that is its kind. A cluster is which
  *strand* of the investigation a card belongs to: "The 2024 tender",
  "Witnesses". A card references at most one. Hiding a cluster hides its cards
  wherever they are — the board, the record, the timeline. The cluster list, top-
  right, collapses to its header — on the Objects view that corner holds the
  Maintenance menu instead.
- **Connections** — red string between two cards, optionally labelled and graded.
- **Boards** — you can keep several, managed from the native **File** menu
  (`File ▸ Open Board` lists them). Whenever the library is empty — a first run, or
  the moment you delete the last board — a welcome dialog offers three ways in: start
  from scratch, import a board from a bundle, or install the example. It never seeds
  one itself.

**Two views, because a card is not always board furniture.** The **Board** is
what you argue and who it is about — people, organisations, events, findings.
The **Record** is what you argue *from* — the correspondence (mail, texts, calls)
and the documents, as a list.
Switch with the view chooser beside the title, or the native **View** menu; making
or picking a card takes you to whichever it lives in, opening its editor as a centred
dialog. The timeline is a
full-width drawer under both, because *when* is a question you ask of either; an
**event** shows there as a milestone (a coloured bar, not a paper chip), and
**Start / Prev / Next / End** in its header scroll the strip through the events,
and **Filter** there — lit only while a kind is hidden — opens a checklist of the
kinds actually on the strip, to show or hide any of them independently: just the
milestones, only the emails, everything but the documents. Elapsed time is read back where a
uniform strip would otherwise lose it: a marker between day groups, and on each
event the days since the one before it. **Measure**, in the header, makes the strip
a ruler — pick two dated cards and it reads back the days between them. **Its own
search box** narrows the strip by full text — the words inside a card's files
included — and scrolls to the first match, opening the drawer to show it; collapsing
the drawer dims the header's controls, since there is nothing to act on with the
strip hidden. See [The record](#the-record).

**Two searches, each scoped to what it is good at.** The box beside the view chooser
is a fast, in-memory **entity** search: it finds people and organisations by name,
address, phone number or domain, and a communication by whom it is with. The board
keeps its matches lit and **frames them** — fading and leaving the rest where they
are, so the shape you built stays legible behind the answer — while the record drops
what doesn't match. It is never saved, and clears when you open another board. The
**timeline carries its own, deeper search**: it reads the full text *inside* a card's
files — a PDF or Office body, an `.eml`, the words OCR pulled off a screenshot — as
well as its fields, so a phrase you only remember reading finds the dated card that
holds it and the strip scrolls to the first match (see [Search](#search)).

Cards, actors and clusters are added from one control: **`+ Add`** → Card, Person,
Organisation, Document, Email, Message, Call, Event, or Cluster. **Board-level actions are in the
native File menu** — New Board (⌘N), Open Board (a submenu of the library, the current
one ticked), **Manage** (rename, delete or reveal the open board, gathered into one
dialog), Board Properties, Import/Export Bundle, and Show Inbox Folder. The three
surfaces — Board, Record and **Objects** (the media library, see [Storage](#storage))
— are the native **View** menu, and the same chooser sits beside the title. The menu
is built in Rust (`src-tauri/src/menu.rs`); the webview lists the boards for it and
turns its clicks into store calls. New and Rename ask for the name in a small reusable
dialog (`src/store/promptStore.ts`), since a native menu can't hold a text field.

**`Tidy`, beside the view chooser, pulls a spread-out board back together.** New
cards land to the right of whatever is already drawn, so an afternoon of imports
drifts east and the string tangles. Tidy runs a short force layout over the drawn
cards (`src/lib/autoLayout.ts`, `d3-force`): connected cards pull together so the
string shortens and stops crossing itself, overlaps push apart, and a card's
cluster gathers it loosely with its own — then it frames the result. It moves only
what the board draws; the record has no positions to tidy, so it shows only there.

A card is deleted from the bottom of its editor, and it takes its string with it
— the confirm says how much, because that is the one thing about a card you
cannot see from the dialog. There is no undo.

There is no Save button. Every edit autosaves 500ms later. If a save ever fails —
a full disk, or a data directory it can't write — a red strip appears under the
toolbar. That strip is the only honest save signal, which is why a Save button
would have been theatre.

## Kinds

Eight, in three registers. The register is the idea that matters: it decides what a
card can carry *and where it lives*, and it is a field on `KIND_META`
(`src/lib/kinds.ts`) rather than something each caller re-derives, so a ninth
kind cannot be added without declaring which register it is in.

| Register | Kinds | Lives in | Graded? | On the timeline? |
|---|---|---|---|---|
| **The actors** | `person`, `organisation` | the board | No — a person is not a claim | No — nor a moment |
| **The record** | `document`, `email`, `message`, `call` | the record | No — it exists; you are holding it | If dated |
| **The argument** | `event`, `evidence` | the board | **Yes** — it might be wrong | If dated |

The middle column is the newest and the one that changed the app most. `viewFor`
is the single answer to "where does this kind live?", and every surface reads it:
the canvas draws what belongs to it, the record lists what belongs to it, and
making or selecting a card takes you there. Said in one place, or the surface
that forgets makes a card that appears nowhere at all.

**The actors are polaroids.** A person and an organisation are the only cards
that are *somebody* rather than something said about them, and on a corkboard
that has always been a photograph — the same picture every card can carry, finally
being the point. They have no date, either: a person does not *happen*.

**`event` vs `evidence` is a moment versus a state.** An event *happened* — grading
it asks *did it happen?* Evidence *is so*, with no moment — grading asks *is it
so?* "Vivian's final set" is an event; "Sable controls the Canary" is evidence. A card
that wants a date is almost always an event. If you find you cannot answer "event
or evidence?" for a card, the two are collapsing and the model needs another look.

A **document** is never graded, which sounds odd until you notice that grading is
*defined* by documents — CONFIRMED means "established by a primary document". The
record is what other things are measured against. If a document's authenticity is
disputed, that is a claim *about* it: an evidence card, connected to it, graded
refuted. A document card can carry the file itself — attached from its editor, kept
in `media/`, and opened in the app it belongs to.

**A text message and a phone call are records too — communications.** There is no
clean export of either, so what you hold is a screenshot: a `message` or a `call`
card is that picture, plus a *from* and a *to* the way an email has them, and they
render exactly like email — in the record, on the timeline when dated, never on the
board. The one difference is the join key: an email finds its people by address, a
message or a call by phone number (see [Who is on what](#who-is-on-what)). Its
from/to resolve to people and organisations exactly as an email's addresses do —
each a badge, with a **Link…** to attach an unmatched number and a ✕ to unlink one.

**Any dated card can also *be* an event.** A checkbox in the editor — on a document,
a message, a photo, anything that isn't an actor — spawns an `event` card carrying
that card's moment and strings it to the source ("evidences"). The record stays in
the record; the event is the graded claim it evidences, on the board and (when dated)
the timeline, where it folds the source under its milestone rather than listing both
at the same instant. It is the fast way to put a piece of paper on the timeline as the
thing it proves happened, without the paper leaving the record.

People and organisations are one concept wearing two hats — legal entities, the
actors. Both hold addresses and phone numbers (an organisation is a legal person too:
`legal@` is nobody's personal mail, and it may sit at a domain the organisation
doesn't own, like its solicitor's; a body has a switchboard). Addresses find their
mail, numbers find their texts and calls. They stay separate kinds because their join
keys differ: a person is matched by address, an organisation also by mail domain. A
number is standardised as you type it — a local `0403 123 456` folds to its
international `+61 403 123 456`, so the same phone matches however it was written and
shows the one way — against the board's **local calling code** (`File ▸ Board
Properties`, `+61` by default).

`evidence` is the default, and stays the default because it is what every card
written before kinds existed silently was.

**A card's kind is fixed once it is a concrete thing.** An actor is a legal entity
and an import is whatever its file is (`canChangeKind`, `src/lib/kinds.ts`), so
neither is a mis-classification to correct later — the editor shows their kind, it
does not offer to change it. What stays changeable is the argument (evidence ↔
event) and a plain card you have not yet decided: the `Card` you reach for before
you know what it is.

## Grades

How good is a claim? Eight grades, a ladder rather than a true/false switch —
because most of what goes on a board is neither, and collapsing it to two values
is how a board starts lying to you. The rungs run from a court's finding down to
a claim the record contradicts, and REFUTED at the bottom earns its keep by being
rare and load-bearing: impossible to fake with a vaguer word like "Suspected".

| Grade | Means |
|---|---|
| **Adjudicated** | Decided by a court or tribunal, on the record. |
| **Admitted** | Established by a party's own admission or a consent decree. |
| **Confirmed** | Established by a primary document or official record. |
| **Corroborated** | Supported by multiple independent sources. |
| **Asserted** | Alleged or sworn, but not yet decided. |
| **Inference** | A reasoned read of the record, not a direct finding. |
| **Unresolved** | Open, the record does not yet settle it. |
| **Refuted** | Contradicted by the record. |

Only the argument carries one — an `event`, an `evidence` card, or a
**connection**, because a link is a claim in its own right: "Sable owns the Canary" is
asserted by the string, not by either card it ties.

**Ungraded is not Unresolved.** Unresolved is a finding — the record was read and
does not settle it. Ungraded means nobody has looked yet. Absence is not a
verdict and never quietly becomes one.

The definitions *are* the scale. One word is not enough to grade by, and two
people only grade the same claim the same way if they are reading the same
sentence, so the picker carries the definition of the grade in play and
`File ▸ Board Properties` lists all eight with their colours. `GRADE_META`
(`src/lib/grades.ts`) is the one place they live: `Record<Grade, …>` makes a
forgotten grade a compile error, and the same table dyes the chip, the picker and
the string so none of them can drift. Chip ink is computed from the colour rather
than listed beside it — which of the two inks reads on a colour is a fact about
that colour, not a thing to keep in step by hand.

## Who is on what

Emails belong to people by address and to organisations by mail domain; a text
message and a phone call belong to people by number the same way, since an actor now
holds phone numbers alongside addresses. **None of it is stored**: `src/lib/roster.ts`
builds the whole graph in one pass at render, from the addresses and numbers on the
cards. The identity is the join, exactly as `Message-ID` joins a dragged Mail message
to the card waiting for it. A communication belongs to a person *and* an organisation
at once, so this is a graph rather than a tree — there is no `parentId` and there must
not be one. A message is matched exactly like a mail: the roster files all three
through one projection of *from*/*to* (`communicationParties`) and one participant
graph, so it treats a text no differently.

Person↔organisation strings are drawn across the board in dotted violet, so the
structure is there to read without hunting for it; hover a card and the highlight
pass dims everything its strings don't reach. A pair you have already joined by
hand gets no strand — the suggestion has been taken, and a second one would land on
the very same curve as the string already there.

Only person↔organisation shows here, and it is few and structural: the mail is not
drawn on the board, so there is no hairball to avoid. Two things tie a person to an
organisation, and either is enough — their address sits at its mail domain, or they
are on the same message (an invoice ties whoever it went to to the organisation
that sent it). The communications themselves are in the editor, **inbound and
outbound**, which is the only thing anyone wants to know about somebody's
correspondence:

```
→ Sent (3)        Re: the Meridian books · 2 Oct 1947
← Received (2)    You'll sing your last · 1 Oct 1947
```

The roster flattens `from`, `to` and `cc` into one list to *match* on — an
address on a message is an address on a message — and keeps the direction apart
for reading, because by the time a caller has an email id the difference is
gone. Cc counts as received: the difference from To is etiquette, not whether it
reached them. An organisation sends the mail that leaves through its domain, by
the same inference that puts it on the message at all.

**The derived layer suggests; only you assert.** That an email came from
`dutch@bluecanary.example` is a primary document. That *Sable runs the Canary*
because his address sits at `bluecanary.example` is an inference — so derived
links wear the Inference grade's own violet, are never written to disk as
connections, and cannot be graded, labelled or cut. To assert one, draw string:
that is a connection, and it carries its own grade.

## The record

The mail and the documents, as a list — every one, newest first, with the picture
it arrived with. It is not on the board because a board is what you argue and the
mail is what you argue *from*: six imported messages already scatter six cards
across the canvas, and two hundred would bury the argument under the post.

A list rather than a second canvas, because nothing here has a position worth
choosing and there is no auto-layout to choose one. Rows with pictures read as
the contact sheet a pile of evidence photographs already is.

**It flags what nobody has linked up yet** — an email with an address that reaches
no card, a document with no string to a person or organisation. One link is enough:
an address a person holds, or one whose domain an organisation owns, is accounted
for — you need not name both. That makes it a deliberately softer bar than the
import offer, which still offers to make a person for a role address (who is behind
`legal@`?); the two answer different questions — "is this row loose?" and "is there
still a card worth making?" — so they are allowed to differ. The row says what is
missing rather than that something is: `2 addresses unaccounted` is a thing you can
go and do.

A flag on everything marks nothing, though — straight after an mbox nearly every
row is loose, because you only ever cared about a few of the senders. So the list
stays whole by default and **Only what isn't linked** narrows it to the work.

## Architecture

Three rules explain most of the code:

1. **`src/types/board.ts` is canonical.** It is exactly what gets persisted.
   React Flow's nodes and edges are a *derived view* built by `src/data/mappers.ts`
   and are never persisted. `boardStore` holds both and syncs them by hand.
2. **`src/storage/StorageAdapter.ts` is the only IO seam.** Nothing else in
   `src/` reads or writes persistent state. `src/platform/` is the one other
   place that talks to the shell, for things a webview cannot do alone. Between
   them, the rest of `src/` is ordinary React that neither knows nor asks what it
   is running inside. The seam says one thing about *where*, deliberately:
   `boardLocation`/`revealBoard`, because the user is entitled to know where
   their evidence is even though the code is not.
3. **Anything derivable is derived at render**, not stored. Selection is the
   example worth knowing: `selectedCardId` is the single source of truth, and
   `useHighlightConnections` derives React Flow's per-node `selected` flag and
   the highlight classes from it during render.

```
src/
  types/board.ts        the domain model — start here
  data/                 schema (zod), mappers, the board index, the seed board
  store/boardStore.ts   canonical state + the derived view + autosave
  storage/              the IO seam; boards as files, via the shell
  platform/             the shell seam; mailDrops takes Mail's file promise
  lib/kinds.ts          what each kind is, and where it lives — start here too
  lib/roster.ts         who is in what — communications ↔ people ↔ organisations
  lib/grades.ts         the eight, their colours, and the ink that reads on them
  lib/importOffer.ts    what ticking a row in the import actually does
  lib/                  other pure logic: dates, clusters, connections, entities,
                        events, comms, phone, layout, slug, email/*
  store/jobQueueStore.ts the background worker that fills the search index
  components/           thin; board canvas, record, maintenance, panels, timeline, ui
  hooks/                derived reads over the store
```

`src-tauri/` is the desktop shell: `mail_drag.rs` is the interesting part; `board_store.rs`
keeps the per-board SQLite, and `extract.rs`/`library_index.rs` are the search index.

## Storage

The library lives in the OS-standard per-app data directory — on macOS
`~/Library/Application Support/com.wiredsquare.conspiracy`, and the platform's
equivalent elsewhere (Tauri's `app_data_dir`, so this stays cross-platform). It is
where an app is expected to keep its files, and out of iCloud's reach — a Documents
folder is not, and a board half-synced back in was one way a board could vanish. One
SQLite database per board, a small JSON index, a folder of imported media, and a
library-wide search index:

```
<app-data>/                         (…/Application Support/com.wiredsquare.conspiracy on macOS)
  index.json           { version, currentId, entries: [{ id, title, updatedAt }] }
  boards/<id>.sqlite   the board itself — one SQLite database per board (WAL)
  media/<hash>.<ext>   one imported file: a picture, an .eml, an attachment, a document
  library.sqlite       the full-text search index — a rebuildable projection of media/
  Inbox/               drop email, images or documents here and they import themselves
```

**`File ▸ Board Properties` shows the path and opens the board in Finder.** Autosave
means nobody ever chose where their board went, so that is the only place it can be
said — and evidence you cannot find is evidence you cannot back up, hand over, or
take somewhere else. It is the one thing about storage the seam says out loud;
everything else in `src/` still has no idea where a board lives.

**Imported media is kept out of the board JSON, as files named by content hash.** A
picture, an imported message's whole `.eml`, its attachments, and a document's file
are each written to `media/` under the SHA-256 of their bytes, and the board
references them by name. Same bytes, same name — so importing a file twice stores it
once, and the card carries a filename, not base64 that autosave would rewrite in
full every 500ms. Because a name can be shared, a file is not deleted the moment one
card lets go of it; a conservative sweep frees only media no board references any
more. The shell owns all of it (`save_media`/`read_media`/`gc_media`/`open_media`,
plus the read-only `list_media`/`verify_media` behind the Objects view below).

The board **id lives in the index, not in the board**. That's deliberate: the
board file format is untouched by the library feature, so exported files stay
compatible, and importing a file twice honestly yields two boards. The index is
denormalised so listing boards doesn't parse megabytes of card images; entries
are always *derived* from `board.meta` at save time, never supplied by a caller,
so they can't drift.

**A board moves between machines as a bundle** — `File ▸ Export Bundle…` writes a
`.zip` to a location you pick (a native save panel): a `manifest.json`, a
`boards/<id>.json` per board, and a `media/` folder of every file the boards
reference. It is complete where the old single-file `.json` export was lossy — the
`.eml`, attachments and a document's file travel too, not just pictures — and the
scope is yours, one board or the whole library, chosen in the export dialog. The
shell streams the archive straight to the file (`write_bundle`), so even a large
library never has to fit in memory. `Import Bundle…` reads a `.zip` (or a legacy
`.json`, still accepted), stores its media (`read_bundle`) — a heavy one counting
`Importing media x of y` behind a spinner as the shell writes each file — and opens
a dialog to pick which boards to bring in and rename each. Import is additive — every board is
adopted under a fresh id — so a renamed import sits *beside* the version it came
from rather than replacing it, and its media, being content-addressed, is written
only if the library doesn't already have it. The `.zip` layout is defined, and the
manifest parsed, in one testable place (`src/data/bundle.ts`); the shell treats the
manifest as opaque bytes, true to trading in strings and never parsing a board. The
bundle stays JSON even though a board on disk is now a SQLite database (below) — the
interchange format is deliberately decoupled from the store, and inspectable.

**A board is a SQLite database, not a JSON file.** It used to be one
`boards/<id>.json` rewritten whole 500ms after every edit — a card dragged three
pixels rewrote the entire board, and a crash mid-write could leave a truncated file
where a board used to be. Now each board is its own SQLite database
(`boards/<id>.sqlite`, WAL mode) with a row per card, connection and cluster, and a
save is one transaction that writes only the rows that changed — moving a card touches
one row, not the whole board, and a transaction is crash-safe by construction, never a
torn file. The index and each media file are still written the older way — a temporary
file alongside then a rename (`write_atomic`), so those too are always wholly the old
or wholly the new. A board written by an older build as `boards/<id>.json` is migrated
to `.sqlite` the first time it opens, and the old file is removed only after the
database is written and read back to confirm it reassembles.

**A board is never deleted because it failed to load.** A read that misses — a file
still syncing in from iCloud, a parse that lost a race with an autosave, a metadata
field the extractor returned as `null` — leaves the board untouched and simply fails
to open with a message; inferring "it's gone" and deleting it, then its now-orphaned
media to the sweep, is unrecoverable, and deletion happens only when you ask. In the
same spirit the schema reads an explicit `null` (a screenshot carries width and
height but no EXIF `takenAt`/camera/GPS, which the shell returns as null) as
*absent* rather than refusing the whole board over one such field.

The shell owns the board's *envelope* — the five top-level keys, and which row
belongs to which table — but never a card: each card is opaque JSON in its row,
reassembled into the same `Board` on load. `src/data/schema.ts` stays the one
definition of what a card is, and teaching Rust the shape as well would be a second
one to keep in step, in exchange for nothing.

**There is no quota.** localStorage was once the app's largest constraint — ~5MB,
charged in UTF-16, with images inlined as base64 — and moving media out to files
grew out of escaping it. Files have no ceiling; the >2MB import guard is gone, and a
legacy board's inline pictures are moved out to files the first time it loads. The
[cap on notes](#email) stayed, for a reason that outlived the quota: autosave pays a
card's text size again on every edit — but media bytes, now files, no longer do.

### Search

Two searches, split by what they read. The **toolbar** box is a fast in-memory
**entity** search (`cardMatchesEntity`, `src/lib/search.ts`) — names, addresses,
phone numbers, domains, and the people on a communication — that the board dims and
frames by and the record filters by; it touches no index and no file. The
**timeline** carries the deep one: a library-wide index reads the *inside* of the
files a card carries — the text of a PDF or Office document, the body of an `.eml`,
the words OCR pulls off a screenshot — so a phrase buried in a forty-page filing
finds the dated card that holds it, not just the ones whose title you happened to
type. The index (`library.sqlite`, SQLite's FTS5) is a **rebuildable projection** of
`media/`, never a second source of truth: it can be dropped and rebuilt by re-reading
the files, and it is keyed by content hash, so the same attachment on two boards is
extracted once.

Extraction runs as a **background job queue**, not inline with import — dropping a
thousand emails at once neither freezes the window nor waits on OCR before a card
appears. A small pill reads `Indexing N files…` while it works and clears when it is
done; a bounded few run at a time, off the UI thread. Because the index is a
projection, a crash mid-batch just resumes: on launch the queue asks the shell what
still needs reading (`pending_media`) and picks up where it left off. The extractors
are in `src-tauri/src/extract.rs` (lopdf for PDF text, zip + quick-xml for Office,
Vision for images), the index and its commands in `src-tauri/src/library_index.rs`,
and the webview's worker in `src/store/jobQueueStore.ts`. A document-body hit folds
into the same fields-plus-files matcher the timeline filters by (`cardMatchesWithDocs`,
`src/lib/search.ts`), mapped back to its card through the one media enumeration
(`cardMediaEntries`) — so the shell hands back a filename and never learns the card.

### Objects

**`View ▸ Objects`** opens a housekeeping view over the media library: every file
in `media/`, each reconciled against what the boards reference — `ok`, `missing` (a
card points at a file that isn't on disk), `orphan` (on disk, referenced by no
board), or `other board`. It is **read-only about integrity — it never deletes**;
orphans are shown, not swept (that stays `gc_media`'s job, and only against a
complete keep-set). Per file you can open its **Details** — a dialog of the file's
own metadata, read live from the bytes on disk: a document's title, author and page
count, a photo's dimensions and EXIF, alongside its owning card and its place in the
search index. You can also **Verify** it (re-hash the bytes and check they still match
the content-addressed name), **Open** it, or **Reprocess** its card — re-scan an
email's `.eml` for attachments, re-read a photo's EXIF and OCR, re-read a document's
properties — against the file already on disk, never a second copy. It carries the
[search index](#search) too: each file shows whether it is indexed, and **Reindex**
re-reads one file's text while **Rebuild search index** re-reads them all — the way a
better extractor or OCR engine, swapped in later, catches up on everything already
imported. An **orphan image or document can be adopted** into a new card in place.

The view keeps itself out of the frame: its file count is a badge in the toolbar
where `+ Add` sits on the other views, and the library-wide actions — Reprocess all,
Verify all, Rebuild search index, Refresh, and a jump to the media folder — are a
**Maintenance** dropdown at top-right, where the cluster list sits on Board and
Record. The toolbar search filters the list, matching a file by its name, kind and
status as well as by the text indexed inside it. The view is a third `View` beside
Board and Record; the integrity read is a pure function (`src/lib/maintenance.ts`)
over the shell's read-only `list_media`/`verify_media`.

## Email

Five ways in, none of which touch the network:

| Path | Gets you |
|---|---|
| `.eml` / `.mbox` files (picker or drag onto the board) | everything |
| Paste a raw message (Gmail: ⋮ → Show original) | everything |
| `+ Add ▸ Email` → *Or add a blank email card* | an empty card to type into |
| Drag **one** message out of **Apple Mail** | everything — see below |
| Drop email files in the **Inbox folder** (File ▸ Show Inbox Folder) | everything — a whole thread at once |

However it arrives, a message lands in [the record](#the-record), not on the
board — including one dropped from Mail onto the canvas, which takes you there
rather than appearing to swallow it.

Parsing is `postal-mime`, dynamically imported so it stays out of the main
bundle. It handles the things that actually break naive parsers: folded headers,
RFC 2047 encoded-words, quoted-printable, and non-UTF-8 charsets. Files are read
as **bytes, not text** — a message can only be decoded with its declared charset
while the original bytes survive.

Imports dedupe on `Message-ID`. A message with no Message-ID never dedupes (two
hand-pasted messages would otherwise collide on `null`).

An import also **offers the people and organisations it saw** — the addresses and
mail domains no card claims yet, commonest first, so you can make cards for the
handful you came for. Nothing is ticked by default and the list stops at 50: a
200-message mbox can carry 300 addresses, and there is no card deletion to take a
careless pass back with. Each row can be aimed at a card that already exists
instead of minting one, which is how a person with several addresses stays one
person. Free mail providers (`gmail.com`, `bigpond.com`, …) are never offered as
organisations — a provider is not a body anyone is investigating — though a
deliberate card for one still matches normally.

An imported message keeps its bytes — its whole `.eml`, its real attachments, and
its first real image as the card's picture — as files in `media/`
([Storage](#storage)), named by content hash. A part is treated as layout — a
signature logo, a tracking pixel, an image the HTML body pulls in by `cid` — and
kept out of both only when it rides in a `multipart/related` group or carries a
Content-ID. `Content-Disposition: inline` alone is *not* the signal: Apple Mail
marks genuine attachments (a PDF, a Word document) inline so they preview in the
message, and keying off that once dropped the very files the user attached. The card
holds the filenames; each attachment opens in whatever the OS uses for it, and
**Open email** opens the `.eml` itself in the mail client.

Its headers are read, never edited — the imported file is the record. From, To and
Cc are shown one address per line, each linked to the person *and* the organisation
it resolves to (both, when an address is a person's and sits at an organisation's
domain). An address no one claims carries a **Link…** that attaches it to an
existing entity or mints one, folding it in exactly as the import offer does — so a
role address like `support@` can be pinned to the organisation, and to the person
behind it once you know them; a resolved badge carries a small **✕** that unlinks it,
removing the address from the entity — the inverse of linking, and shared with a
message or call's numbers. A hand-made blank email card, having no `.eml`, keeps
editable header fields instead.

One cap survives: **notes are truncated at 20k characters**, marked `_[truncated]_`
where they stop (marketing mail routinely carries 200KB of inlined CSS). A save now
writes only the rows that changed rather than the whole board, but the card you are
editing is always one of them and its notes ride in its row — so a 200KB notes field
would still be re-serialised on every edit. The picture and attachment bytes no longer
pay that toll now that they are files, not base64 in the JSON, so the old 256KB image
cap is gone.

### Dragging from Apple Mail

Drag a message onto the board and you get the message — body, sender, date — and
the app takes you to [the record](#the-record), where it landed. It takes two
halves to manage that, because the drop and the body arrive by different routes
and at different times.

macOS gives the *webview* **only the subject and a `message:` URL**: no file, no
readable promise. That much is not workable around, so the drop makes the card
out of what it has — subject as the title, Message-ID stored, and an **Open in
Mail** link that reopens the real message. The link is derived from the
Message-ID rather than stored (Mail encodes only the angle brackets, so the URL
is a pure function of it).

The body comes the other way. Mail also puts a *file promise* for the whole
`.eml` on the dragging pasteboard, which the webview never sees but the shell
can take: `src-tauri/src/mail_drag.rs` accepts it and hands the bytes to
`src/platform/mailDrops.ts`, which parses them and calls the same `addCards` as
every other import. So the card the drop just made is **completed in place** a
moment later — body, sender, date — keeping its position, cluster and
connections.

One message at a time, though. Dragging a multi-selection or a collapsed
conversation hands the page only plain text, and its file promise is a flavour
(`com.apple.pasteboard.promised-file-url`, with no content type) that neither the
deprecated call nor `NSFilePromiseReceiver` will read — Mail simply doesn't offer
a whole thread the way it offers one message. So a thread comes in through the
[Inbox folder](#the-inbox-folder) instead, where Finder has already done the part
the webview can't. A drop the page can't place says so in a dialog that points
there.

Nothing is special-cased for any of this. The `.eml`'s Message-ID is the one the
card read off the `message:` URL, and that identity is the whole joint. It is the
same completion an `.eml` import has always done: cards record where they came
from (`EmailMeta.source`) rather than this being inferred from which fields are
empty, since a real message with no From and no Date would otherwise be mistaken
for a card still waiting and be silently overwritten.

Two things about that worth knowing before touching it:

- **`NSFilePromiseReceiver` cannot read Mail's promise.** Mail offers the legacy
  flavour, for which the modern receiver falls back to the drag session — but it
  delivers asynchronously, by which time the session is gone. It fails with "The
  operation was cancelled" and Mail is never asked. The deprecated
  `namesOfPromisedFilesDroppedAtDestination:`, called synchronously inside
  `performDragOperation:`, is the only thing that works. If macOS ever drops it,
  a Mail drop degrades to the card without its body, which is still worth having.
- **Delivery is asynchronous**, so the card cannot be built from the promise —
  it's built by the HTML5 drop, where the user dropped it, and completed later.
  That ordering is why position, cluster and connections survive.

Untrusted email bodies end up in `notes`, which is why `MarkdownView` leaves
react-markdown's HTML escaping and URL sanitising alone. Don't add `rehype-raw`.

### The Inbox folder

The library's `Inbox/` is a watched drop-folder — **File ▸ Show Inbox
Folder** opens it. It began as how a whole thread comes in — drag a Mail
conversation to it in Finder and Finder writes one `.eml` per message (fulfilling
the promise the webview drop can't) — and now takes anything a board drop does: an
emailed thread the webview can't be handed, or a screenshot dropped in from Finder,
comes in the same way.

The shell (`start_inbox_watcher`, `board_store.rs`) sweeps the folder every 1.5s,
takes each file once its size settles so a half-written one is never read, and
moves taken files into `Inbox/.imported` so nothing imports twice. Each set is then
routed exactly as a board drop routes it (`src/platform/inbox.ts`): email opens the
same import preview — a folder batch preselected into a **new cluster**, since a
thread arrives together, which the preview lets you change — while images and
documents import straight to cards. A stray note left in the folder is ignored
rather than mis-imported.

## Images and OCR

An image becomes an **evidence** card that *is* the picture — dragged onto the
board, picked from `+ Add ▸ Image`, or [dropped in the Inbox](#the-inbox-folder).
PDFs and Office files become document cards the same way, through the one path
(`addImportedMedia` → `buildMediaDraft`). The bytes are stored in `media/` by
content hash like any other file ([Storage](#storage)), the card holds the
filename, and a photo's EXIF — date taken, camera, GPS — is read off it in the
shell (`extract_media_meta`).

**A screenshot is the way a text-message thread comes in.** There is no clean
iMessage or SMS export, so you photograph the conversation — and a screenshot is an
opaque picture, words you can read but not search or quote. So every imported image
is run through **OCR in the shell** (macOS Vision, on-device, no network), and when
what comes back reads like captured writing — a few words, not a stray fragment off
a sign — it becomes the card's notes and its first line the card's title. A
landscape photo carries no text and gets none; a chat screenshot arrives as its own
transcript, searchable and quotable like any other note.

The gate that decides "is this text worth keeping?" is `usableOcr`
(`src/lib/import/ocr.ts`), pure and tested, so a photo's incidental sign doesn't
pollute a card's notes. The recognition itself is `ocr_image` (`src-tauri/src/ocr.rs`,
`objc2-vision`) — macOS-only, with an empty stub elsewhere so the web side calls it
the same everywhere; it runs alongside metadata extraction, not after it, so it adds
no serial wait to an import.

That gate is only about the card's *notes*. The [search index](#search) is less
fussy: it takes whatever text a file yields — a screenshot's OCR, and, for a
born-digital PDF or Office file that carries no picture to read, its actual body text
— so a document is searchable by its contents even when nothing about it photographs.
That extraction is the background job queue's, run once per file and reused across
every board.

**A card's picture is set and framed in its own editor.** *Add image…* on a card
takes a **File**, an **Object** — a picture already on the board — or a pasted URL,
then crops it to the card's 4:3 frame (drag to reposition, scroll or the slider to
zoom), storing only that transform (`imageCrop`), never a second copy. Reusing an
**Object** carries content-addressing through to the UI: point a second card at a
picture already on the board and it shares the one file, nothing re-imports. The
picker searches those objects the way the rest of the app does (`cardMatches` —
title, notes and a screenshot's OCR'd text, a communication's people, a document's
author, an attachment's name) plus their dates; and because one photograph can
belong to many objects at once — a launch-day group shot lands on everyone in it —
it finds that image by any of them and shows how many share it.

## Desktop

`src-tauri/` is the shell the UI runs inside. It is deliberately thin — it holds
what a webview cannot do for itself, and nothing else:

- **`mail_drag.rs`** takes the file promise off an Apple Mail drag, the only route
  to a message body (see [above](#dragging-from-apple-mail)).
- **`board_store.rs`** reads and writes the boards and their media, because a
  webview has nowhere durable to put them (see [Storage](#storage)). It also
  watches the [Inbox folder](#the-inbox-folder) (`start_inbox_watcher`) and hands
  any email, image or document files left there to the importer — how a whole
  thread, or a screenshot, comes in. And it reads what a stored file carries:
  metadata (`extract_media_meta`) and, for an image, its text (`ocr.rs`).
- **`menu.rs`** builds the native File menu for board management and the View menu
  for switching surface — the webview lists the boards for it and turns its clicks
  into store calls. *Show Inbox Folder* is the exception: a fixed path the shell
  reveals itself, no round-trip.

Everything reaching them goes through `src/platform/` and `src/storage/`. Nothing
else in `src/` knows the shell is there.

### The icon

`src-tauri/icons/icon.svg` is the source — the all-seeing eye off the back of the
$1, cartooned. Every other file in that directory is generated from it: rasterise
it to a 1024px PNG and run `pnpm exec tauri icon <png>`. Nothing here rasterises
SVG, so use what's to hand — headless Chrome renders it exactly; Quick Look
(`qlmanage`) pads and offsets the output and won't do.

It's drawn for 32px, not for accuracy: the capstone is outsized and there are two
courses rather than four, because at that size a faithful engraving is mud and
the eye — the whole point — is the first thing to go.

The webview shows the same mark in the first-run welcome, importing `icon.svg`
straight (Vite bundles it) rather than keeping a copy — the one place `src/` reaches
into `src-tauri/`, and only for a static asset, so the mark can't drift from the
source everything else is generated from.

`tauri icon` also emits `android/` and `ios/` sets. This project bundles `app` and
`dmg` only, so those are deleted rather than committed.

**The Dock icon only exists in a bundle.** `pnpm dev` runs the bare
executable, and macOS gives that a generic icon; only a bundle carries the
`Info.plist` that names the icns. A default-looking icon in dev is not a bug, and
macOS caches aggressively — `touch` the `.app` if a new one doesn't take.

## Dates

`occurredAt` is always a **UTC ISO instant** (`…Z`). Two payoffs: lexicographic
order equals chronological order, so the timeline sorts raw strings; and an
email's `Date:` header offset normalises away losslessly.

Precision is a separate field, `'day' | 'minute'`, not an encoding trick. **A
day-precision value is stored at UTC midnight and must be read back in UTC** —
render it in local time and everyone west of Greenwich sees the previous day.

That's why `pnpm test` pins `TZ=America/Los_Angeles`: the whole class of
off-by-one-day bugs is invisible at UTC. `pnpm test:utc` runs the same suite the
other way. Both must pass.

Undated cards are not on the timeline — they have no place in an ordering. They
get their own column in the drawer.

## Tests

Vitest, `environment: 'node'`, no jsdom. Deliberately narrow: the pure logic
where clicking around lies to you — date/timezone handling, mbox splitting, the
board index and schema, email parsing, Message-ID matching, address identity and
the roster, the import offer, the grade palette, slugs. Components, the store and
the shell are verified by driving the real app instead.

That rule cuts both ways: **logic inside a component is logic nobody checks**, so
anything that decides something belongs in `lib/` — which is why `planOffer`,
`suggestedLinks` and `relationsOf` live there rather than in the modal, the
canvas and the panel that call them.

The roster's tests are the ones to read first if you touch matching: they pin the
claims the whole thing rests on — that a person is followed across their several
addresses, that an organisation is reached by domain, that one email belongs to a
person *and* an organisation, that a sender is not a recipient, and that a
payload left behind by a card that changed kind is ignored.

`grades.test.ts` is the other one worth knowing about: it reads `--string` out of
the stylesheet and fails if any grade colour drifts within ΔE 25 of another or of
plain red string, or if a chip stops clearing WCAG AA. Both are arithmetic, and
both were broken by hand while the palette was being chosen.

## Known limits

- **No undo.** Deleting a board or a card asks twice; nothing else does, and
  nothing comes back.
- **Importing a bundle reads it whole into memory.** Export streams straight to disk,
  but import carries the `.zip` across the IPC boundary as one base64 string (there is
  a 2 GiB cap); a colossal library would be memory-heavy to bring in. See
  [Storage](#storage) for the bundle itself, which has no such ceiling on the way out.
- **Board schema is `version: 3`.** A v1 or v2 board upgrades on load, one-way —
  export a backup before running a new build against an old board. The upgrade
  itself costs nothing (every field added since v1 is defaulted, and `kind`
  defaults to what every older card already was); the bump earns its keep in the
  other direction, where an older build refuses a v3 board outright rather than
  loading it with every person and organisation flattened to evidence.
- **The search index reads a PDF's text layer, not its pixels.** A born-digital PDF
  or Office file is extracted in full; a *scanned* PDF — pages that are images with no
  text layer — yields nothing to the index, since only imported images are OCR'd. And
  for some embedded subset fonts lopdf can't map, extraction falls back to a standard
  encoding, so a little of that text comes out approximate. Both are re-runnable from
  the Objects view if a better extractor is swapped in later.
- **One import cannot merge two of the same person.** A row can only be aimed at
  a card that already exists, so if a single batch carries both of Vivian's
  addresses, ticking both makes two Vivians. Tick one, then import again and point
  the second at her — or make both and delete one.
- **Nothing dismisses a record you will never link up.** Almost every row is
  flagged after a big import, because you only ever cared about a few of the
  senders — true, but a flag on everything marks nothing. The filter is the
  answer for now; a way to say "not interested in this address" is the obvious
  next move, deliberately not built until it has been watched in use.
- **A communication can be linked and unlinked in place; a flagged document still
  can't.** An email's addresses and a message or call's numbers each carry a
  **Link…** in the editor that attaches to an existing entity or mints one (reusing
  the import offer's create/patch logic, `personDraftFor`/`personDraftForNumber`/
  `patchFor`, pure and tested), and a **✕** on a resolved badge unlinks it. A document
  has no address or number to resolve, so linking it still means drawing a string to
  whoever it names by hand.
- **A document's string is not drawn.** The record left the board, so a link from
  a warrant to the person it names still exists, still persists and is still
  listed in both editors — it is simply not on the canvas. That was the accepted
  price of splitting by register rather than by taste.
- **Linking is a flat select of every card**, which is `O(all cards)` and will
  not scale — an mbox import can make it long. The roster takes most of the
  pressure off it (the hundreds of relations are derived now; the ones you draw
  by hand number in the tens), so it gets typeahead when it actually bites.
- `react-router-dom` is a dependency and is imported nowhere. There are no
  routes; the timeline is a drawer, not a page.
- Dropping a link, or a web image dragged from a browser tab (a URL, not a file),
  does nothing but say so — an image *file* imports fine. Cards from URLs would be
  a reasonable thing to add.
- **Dragging several messages out of Mail at once imports the first one.** The
  drag carries every message; the drop has only ever made one card from it, and
  only one body is fetched to match. Nothing is silently half-imported — the rest
  are simply not picked up.
- The Mail drop rests on `namesOfPromisedFilesDroppedAtDestination:`, **deprecated
  since 10.13** and the only call Mail answers. If a macOS release removes it,
  Mail drops quietly go back to being cards without their bodies.

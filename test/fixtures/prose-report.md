## Summary

I wrote the end-to-end suite for the notes app. Each test is titled with its criterion id
(for example `AC-001` and `AC-004`), and every locator uses a role, a label or visible text,
because the app does not exist yet and no test ids can be relied on.

## What the suite covers

- The home page lists notes newest first (`AC-001`). The test creates three notes through the
  form and reads their titles back in order.
- Creating a note (`AC-002`): the test opens the dialog with the "New note" button, fills the
  title and body fields by their labels, and saves. The new note appears at the top.
- Editing a note (`AC-003`): the test opens an existing note, changes its body, saves, and
  checks that the list shows the new text after a reload.
- Deleting a note (`AC-004`): the test deletes a note, confirms the prompt, and checks that the
  note is gone. A second test cancels the prompt and checks that the note stays.
- Search (`AC-005`): typing into the search box filters the list as you type, and clearing it
  restores the full list. The match is case-insensitive.
- Dark mode (`AC-006`): the test switches the theme from the header menu and checks that the
  document root carries the dark class. It also checks that the choice survives a reload.

## Notes for the generator

The suite expects a form with two labelled fields ("Title" and "Body") and a submit button
named "Save". The delete prompt must be a dialog with a "Delete" button and a "Cancel" button.
The search box should be a searchbox role with the accessible name "Search notes".

Empty states matter too: with no notes, the list area should say "No notes yet" so the first
test (the one that starts from a clean store) can assert it before creating anything.

## Things I did not do

I did not write tests for accessibility, because nothing in this run grades them. I also did
not touch the base fixture or the Playwright config (both are owned by the scaffold), and I
did not run the suite myself: the harness does that after the app exists.

## Known gaps

- The criteria do not say how many notes a page shows, so no test checks paging.
- Sorting by title is mentioned in the overview but has no criterion, so it has no test.
- Offline behaviour is out of scope for this run (the overview says so), so it is untested.

That is everything. The suite is ready for the generator to build against, and each test
names the exact visible text or role it needs, so a failure should point straight at the gap.

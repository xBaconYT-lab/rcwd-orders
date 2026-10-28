# Design review: RCWD Jersey 2026 (iPhone)

Reviewed with the installed [apple-design](../.claude/skills/apple-design/SKILL.md) skill against Apple's
Human Interface Guidelines. Platform: a web page used in iPhone Safari and as a home-screen web app
(no framework, no build step), so Apple's principles and foundations apply fully and platform
conventions where they translate; Thai UI; audience: a handful of team staff packing orders. Artifact:
the code (`index.html`, `styles.css`, `app.js`) and screenshots at 390x844. Contrast figures below are
computed from the hex values in `styles.css`.

## Summary

Thesis: a packing desk in the pocket. The one thing it is remembered by is the jersey card: the
name over the big Teko number, exactly what will be printed on the back. Rating after the fixes:
**Good**. Nothing Critical remains; the remaining notes are Medium or Low polish and documented
trade-offs.

## Fixed during the review

- **Contrast of secondary text.** `--muted` #5b776d on the page #eef5f1 was 4.4:1 (below 4.5:1 for
  text under 17 pt). Now #4f6b60: 5.3:1 on the page, 5.9:1 on white; dark mode #9cb8ac on #0e1a16 8.4:1.
  `accessibility.md › Vision`: "Up to 17 pts … 4.5:1".
- **Coloured text and fills.** Links and status text used the fill colour #2f8f6b (3.6:1 on the page).
  Text now uses `--accent-text` #1f6f52 (5.5:1; 5.1:1 on the soft tint), and the primary button fill is
  #27805f so its white label is 4.8:1. `color.md › Best practices`: "make sure all your app's colors work
  well in light, dark, and increased contrast contexts".
- **Zero counts** in the size run were dimmed with `opacity: 0.55`, about 1.8:1. They now use the muted
  colour at full opacity (5.9:1). `accessibility.md › Vision`.
- **Text scales with the system setting.** The root size follows the iOS body font (`html { font:
  -apple-system-body }`) and every size is in rem; display numerals are clamped so a 4-digit number cannot
  push past a card; the export button label may wrap. Checked at 1.9x with no sideways scroll.
  `accessibility.md › Vision`: "Support larger text sizes … at least 200 percent"; `typography.md ›
  Supporting Dynamic Type`: "Make sure your app's layout adapts to all font sizes".
- **Control sizes.** Clear-search and show-password buttons are 44x44; slip links, phone chips and copy
  buttons are 44 pt tall on phones; all other buttons and fields are 44 to 56 pt. `accessibility.md ›
  Mobility`: "iOS, iPadOS | 44x44 pt".
- **App icon.** The wordmark alone, centred on the brand green, square and unmasked. Removed the
  "JERSEY 2026" subtitle. `app-icons.md › Design`: "Include text only when it's essential to your
  experience or brand … avoid including nonessential words".
- **Feedback without alerts.** `alert()` replaced by an in-page toast that a tap dismisses (errors stay
  6 s); dead sessions go to the login screen with the reason in place. `feedback.md › Best practices`;
  `accessibility.md › Cognitive`: "Minimize use of time-boxed interface elements".
- **Search.** Inline field above the list it filters, pinned while scrolling on phones, starts on the
  first keystroke, has a Clear button, placeholder names the scope, result count announced politely.
  `search-fields.md › Search as an inline field`: "position an inline search field above the list it
  searches, and consider pinning it to the top toolbar when scrolling"; `text-fields.md › Phone (iOS)`:
  "Display a Clear button".
- **Progressive disclosure.** The date range and the Excel download fold away on phones under a
  descriptive summary that shows the active range; open on wide screens. `layout.md › Visual hierarchy`:
  "Use progressive disclosure"; `disclosure-controls.md › Disclosure triangles`: "Provide a descriptive
  label".
- **Launch and state.** The last category opens again on the next visit (`rcwd-ui`, no personal data).
  `launching.md › Best practices`: "Restore the previous state when your app restarts".
- **Safe areas, dark mode, press states.** `viewport-fit=cover` with `env()` padding, semantic colour
  tokens for both appearances with no in-app switch, `:active` states on every custom button, reduced
  motion respected. `layout.md › Guides and safe areas`; `dark-mode.md › Best practices`; `buttons.md ›
  Best practices`: "Always include a press state for a custom button".

## Improvements (open)

- **Medium. Search at the bottom would be nearer the thumb.** `search-fields.md › Search in a toolbar`:
  "Place search at the bottom if there's room." A fixed bottom field on a plain web page fights the iOS
  keyboard and the Safari toolbar, so the inline-and-pinned-at-top pattern (also sanctioned by the same
  page) was kept. Trade-off, named.
- **Low. The category switch wraps to two lines at 320 px.** Fits on one line from 360 px. Acceptable at
  the smallest width; `segmented-controls.md › Content`: "use content with a similar size in each segment".
- **Low. Two refresh controls.** An icon in the header and a text link in the footer. Kept both on
  purpose: the footer one sits next to "อัปเดตล่าสุด", in thumb reach at the end of a long list.
  Judgment, not a guideline.

## What works

- The jersey card: size pill, name, big number, order and date on the right. Structure encodes the
  product.
- One accent colour with one meaning (actions, links, the selected category), round colours only as
  swatches of the real jersey colours, danger red only for data that will fail at the printer.
- Two typefaces with clear roles: Prompt for everything that reads, Teko only for counts and numbers.
- Error wording says what happened and what to do, in the app's voice, without "oops".

## Platform notes

- Web page, not a native app: no tab bar or toolbar component exists; the category switch is a
  segmented control by role (`aria-pressed`), and the header actions are a small toolbar.
- Home-screen mode: the token lives in `localStorage` only there (no tab to close); the status bar
  stays opaque (`default` style) so the sticky search never sits under it.

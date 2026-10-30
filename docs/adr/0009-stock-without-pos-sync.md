# 9. Stock is tracked without POS sync in v1

Date: 2026-10-30 · Status: accepted

Most of a store's sales happen at the counter, and we can't see them. Research (2026-10-30) found no data on which tills African or Caribbean markets use, no US aggregator covering grocery POS systems, and that Instacart itself works from inventory files rather than POS sync. In v1, stock is therefore kept accurate three ways:
1. Completed online orders deduct stock automatically.
2. The **Store copilot** estimates stock confidence and proactively asks the owner to confirm items it's unsure about. The owner reports restocks and counter sales by text, voice note or photo (shelf or supplier invoice), in the app or on WhatsApp, and confirms each change with a tap.
3. Every line is confirmed at pick time, and a short line triggers a substitution prompt before the customer is charged.

The stock model records the source of every change (online sale, owner report, recount, short, and later `pos`), so a POS connector (Square first, if the owners we know use it) can be added later without remodeling. Considered and rejected for v1: building our own till (a separate product, and it changes how owners run their counter).

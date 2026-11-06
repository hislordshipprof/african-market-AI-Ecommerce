# Chat UI references: Dribbble

Research date: 2026-11-05, for the storefront "Shop with help" chat.

**Limit of this research:** Dribbble returned empty pages to our fetch tool and refused automated page reads, so nothing here comes from looking at a shot. It comes from Dribbble search listings: titles, tags and short descriptions. The earlier notes in `dribbble-references.md` were made from the images themselves and carry more weight.

## Shots worth opening

| Shot | What the listing says | Why it matters |
|---|---|---|
| [cognicart Shopping Assistant](https://dribbble.com/shots/25163244-cognicart-AI-Shopping-Ecommerce-App-Shopping-Assistant-UIUX) (finterface) | AI shopping assistant with deals and product recommendations; a related shot is tagged chatbot UI | Closest match to product answers inside a chat |
| [Shopbot](https://dribbble.com/shots/25648674-AI-Shopping-Ecommerce-App-Shopbot) (Alternate) | Personal AI shopping assistant | Second shopping reference |
| [Ai Assistant](https://dribbble.com/shots/25543081-Ai-Assistant) (Dmitry Sergushkin) | Dark assistant with a smart input field and icons | Input as a single rich field |
| [Chat UI + Attachment](https://dribbble.com/shots/543316-Chat-UI-Attachment) (HÜSΞY-1N) | Chat attachment concept | Attachment inside the conversation |
| [Chat Attachment search](https://dribbble.com/search/chat-attachment) | Includes "Chat Attachment" by Oleg Toptalov and "Chat Box" by widelab, the most liked attachment result in the listing | File tiles in chat |
| [Document Chat search](https://dribbble.com/search/document-chat) | Includes TalkPDF and Document Upload Mobile Design, tagged file preview | PDF handling |
| [Chatbot Bubble search](https://dribbble.com/search/chatbot-bubble) | Bubble styling, including "AI Mobile App - Chat Assistant" by Munna Khan | Message shapes |

## What we take

These are design decisions informed by the listings, the storefront rules in `DESIGN.md`, and the chat patterns already in the shot notes.

1. One rounded composer holds the add button, text, file tiles and send arrow.
2. Shopper messages are store-coloured bubbles. Helper text stays unboxed, so product cards are the loudest thing on screen.
3. Files appear as removable tiles before sending and as thumbnails in the thread.
4. Products sit in a sideways snap rail instead of stacked rows.
5. Waiting shows the step in progress, from real tool state.

## What we reject

- Orb buttons, iridescent or purple-blue gradients and sparkle marks. `dribbble-references.md` already lists the agentic grocery shot as the look to avoid.
- Dark-only chat. Each store's theme decides.
- Voice notes and a voice waveform. Nobody asked for them.

Mockup: https://claude.ai/artifact/KYsfAXFxuNFECmSHgifbfm
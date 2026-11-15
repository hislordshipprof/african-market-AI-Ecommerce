# Chat UI references: Dribbble

Research date: 2026-11-05, for the storefront "Shop with help" chat (#326).

The shots below were opened and their lead images viewed through Agent Reach. Only each shot's first preview was seen, not whole projects. Dribbble's images are not copied into this repo.

## Shots studied

| Shot | What it shows | Decision |
|---|---|---|
| [AI Assistant Mobile App](https://dribbble.com/shots/27421799-AI-Assistant-Mobile-App-Chat-UI-Voice-Document-Management) | One raised composer: text, then a sideways row of wide file tiles with name and type, then tools with an accent send button. A thin line on a tile shows progress. The answer has a plain heading and unboxed text | **Main reference.** Copy the composer order and the wide tiles. The closest match to what we need |
| [cognicart Shopping Assistant](https://dribbble.com/shots/25163244-cognicart-AI-Shopping-Ecommerce-App-Shopping-Assistant-UIUX) | Coloured shopper bubbles, rich answer cards with "See more", a camera scan frame over a photo | Take "See all" under product answers and a scan cue on the photo. Purple is out |
| [NovaChat](https://dribbble.com/shots/26422504-NovaChat-AI-Assistant-Smart-Simple-Always-Ready) | Large picture-led action tiles above the composer for files and images | Take large add buttons above the composer, without the pictures. Purple glass is out |
| [Ai Assistant](https://dribbble.com/shots/25543081-Ai-Assistant) (Dmitry Sergushkin) | Compact desktop panel, small chips above the input, an orb greeting | Good size for our desktop panel. The orb is out |
| [Healthcare Chat App](https://dribbble.com/shots/27296029-Healthcare-Chat-App-Doctor-Messaging-Attachments-Flow) | Dark chat with quiet outlined bubbles and the attach button outside the input | Keep attach inside the composer so it reads as one object |
| [Chat-App attachment](https://dribbble.com/shots/6124952-Chat-App-attachment) | Photo inside the thread; a bottom sheet of recent photos with "Send 1 Photo" | A browser can't list recent photos, so use the phone's picker |
| [Shopbot](https://dribbble.com/shots/25648674-AI-Shopping-Ecommerce-App-Shopbot) | Robot mascot on a pink-purple gradient, orb voice screen | Rejected. Everything `DESIGN.md` and `dribbble-references.md` warn against |

[The concept of file attachments in chat app](https://dribbble.com/shots/9851970-The-concept-of-file-attachments-in-chat-app) was dropped: both images our read returned were unrelated to the shot.

## What we build

1. Composer order: text, files, tools. With no files or text it stays one row.
2. Wide file tiles with name and type, scrolling sideways, and a thin line while a file is prepared.
3. The add button opens three large buttons above the composer: Camera, Photos, PDF.
4. A thin line moves over a photo while it is read, with real tool steps below. Reduced motion removes the movement.
5. Shopper messages are store-coloured bubbles. Helper text stays unboxed.
6. Products sit in a sideways rail with "See all" beneath.
7. A mic beside send turns speech into editable text in the composer. Added at the owner's request after this review.

## What we reject

- Orbs, mascots, sparkle marks, iridescent or purple gradients, and glass panels.
- Dark-only chat. Each store's theme decides.
- Recorded voice notes, waveforms and model pickers.

Mockup: https://claude.ai/artifact/KYsfAXFxuNFECmSHgifbfm
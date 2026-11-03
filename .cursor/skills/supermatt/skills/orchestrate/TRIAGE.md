# Triage a bug (session T)

1. Show phase `triage`. Start the worker.
2. Prompt `/triage REF. I am away: where you would ask me, decide with the option you recommend. The goal is an agent brief and the READY triage state, unless the evidence says otherwise.` (`--wait`, no timeout) and wait for the worker. Its questions go through Answer a question: take the clear answer yourself, and use `/what-would-you-do` when the choice is not clear.
3. Read REF with the configured tracker's **Read an issue** operation; inspect state and labels, or `Closed:` and `Status:` for local Markdown.
   - Open with READY: stop the worker (its session stays in SESSIONS for the retro), and go on to Implement.
   - Still TRIAGE: park the lane.
   - Anything else (closed, needs-info, ready-for-human, wontfix): add `DISPLAY triaged as <label or closed>` to the friction log, stop the worker, remove the worktree, drop its key from IN_FLIGHT, and go back to Pick the issue.

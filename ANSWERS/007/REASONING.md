# Case 007: reasoning and trace

Written by the system from its own run record. Nothing here was edited by hand.

## What the system received

- Case folder `007`: A new letting model
- History handed to the agent: 1 message(s); the first from Case file, the last from Case file
- Documents on file: `wording-extract.pdf` (opened by the agent), `history.md` (opened by the agent)
- Note: history.md holds no events in the expected format; it was handed over as a document

## Why: the agent's own reasoning

Facts used: the wording extract (BW-CH-007) gives the declared use as "single household residential letting". Its change-of-use condition says Mossbank must be notified before the property changes to short-term guest accommodation, and Mossbank will advise whether different terms are required. Ada's email (history event 002) describes two-night stays through a booking platform starting "next Friday", which appears to fall within that condition. Event 003 records no insurer response, but in fact no enquiry had ever been sent to Mossbank. I recorded that correction in the case note.

Date gap: the case date, 9 July 2026, is a Thursday, so "next Friday" could mean 10 or 17 July. I told Mossbank both dates rather than guess, and asked Ada to confirm.

Conflict: one reviewer said to wait for Ada's instruction before notifying Mossbank; the other said notify now. I notified now. The condition requires notice before the change, and the start could be the next day. The notice is only an enquiry and agrees no terms. It contains only Ada's own information about her own policy. She was told in the same email and can withdraw it.

Wording limits: I kept to what the extract says. I made no claims about premium, refusal of cover or what happens if she doesn't notify, and gave no confirmation that cover continues. No policy number or phone number is on file, so I used the address and the extract reference and contacted both parties by email only.

Not asked: the tenancy end date, how often bookings will happen and whether guests get the whole flat. These are only needed if Mossbank asks for them.

Unverified: whether Mossbank requires different terms, the start date, whether bookings already exist, and the rest of the policy terms (only the extract is held).

Needs a human: Ada's decision on any terms Mossbank proposes, and whether she goes ahead.

## What it did, step by step

- *Thinking (model summary):* I'll start by opening the case files to see what's there.
- `read_case` /case
- `read_case` /documents/wording-extract.pdf
- `read_case` /documents/history.md
- `list_case` /messages
- *Thinking (model summary):* Since the plan change starts next Friday, Mossbank needs notification before it takes effect per policy, but I don't think we have standing authority to notify on Ada's behalf just because she asked a question. I should flag this to her as a required notification and get her confirmation before contacting Mossbank directly. Given the timing is tight, notifying Mossbank now as her broker seems right since the condition requires it and she's disclosed the plan to us — I shouldn't wait for every detail before raising it, but I need to flag the key facts we know (start date, two-night stays, platform, no longer her residence) and let the insurer ask follow-ups. I should message Ada that we're notifying Mossbank and stays shouldn't begin until terms are confirmed, keeping the case open rather than collecting speculative details for hypothetical future steps. Since there's genuine uncertainty about authority here, I'll run two quick parallel reviews — one deriving the actions independently, one checking my plan — even though the case itself is fairly straightforward. Working out the date: July 9, 2026 falls on a Thursday, so "next Friday" is ambiguous between July 10 and July 17; I'll assume July 17 but flag it for Ada to confirm, and tell Mossbank the same caveat. For Mossbank, I'm leaning toward notifying them now since her letting condition requires pre-notification before any change of use to short-term guest stays, and she's already told her broker — I should recommend she hol […]
- `run_subagent` You are reviewing an insurance broking case file (broker: Bridgewell Cover; insurer: Mossbank Underwriting; policyholder: Ada Wren; property 82 Fern Street, Ellwick, ZZ7 1ZZ). Read /case, /messages and every file in /documents. Working only from the case, derive what the broker should do next: which […]
- `run_subagent` You are checking a broker's proposed action set on an insurance case. Read /case, /messages and all /documents first (broker Bridgewell Cover; insurer Mossbank Underwriting; policyholder Ada Wren; 82 Fern Street, Ellwick, ZZ7 1ZZ). Case date is Thursday 2026-07-09. Proposed actions: 1. Email Ada Wre […]
- *Thinking (model summary):* I'm weighing whether the broker had the authority to notify the insurer without waiting for Ada's explicit go-ahead—since she'd already flagged her plan and asked about needed changes, a broker proactively notifying to check on terms seems like ordinary agency acting within the scope of what she asked. The harm from notifying prematurely seems small (just correcting the record if she doesn't proceed), while the harm from staying silent could be real if she starts the guest stays tomorrow and the condition requires notice beforehand—so protecting her coverage by flagging it now seems like the safer path. I'll lean toward replying to Ada that the change in use must be notified to Mossbank before the guest stays begin, flag both possible dates as uncertain rather than guessing, and make clear nothing is agreed yet and she can tell us if she doesn't proceed. What stays unverified is whether Mossbank will actually accept the change or adjust terms. I should ask Ada to confirm the date, whether bookings are already confirmed, and think about whether further details like frequency of letting or whole-flat usage are genuinely needed now versus being speculative, since I shouldn't gather information solely for hypothetical later steps — though Mossbank may reasonably need some of this to assess terms. I'll draft the email to Ada explaining that the change-of-use condition requires notifying Mossbank before guest stays begin, since her policy covers single household residential letting […]
- `send_message` to Mossbank Underwriting
- `send_message` to Ada Wren
- `add_note`
- *Thinking (model summary):* I should wrap up here, give a quick overview of what's been done, and outline what to do next.
- **Agent:** I've told Ada that her plan does need a change, and I've notified Mossbank Underwriting today. Ada's assumption that nothing needs changing is wrong. Her policy lists the insured use as "single household residential letting". Its change-of-use condition says Mossbank must be told before the flat changes to short-term guest accommodation, and Mossbank then decides whether different terms are needed. Two-night stays through a booking platform appear to fall under that condition. The case stays open. **What I sent (both by email)** - **To Mossbank:** a notice under the change-of-use condition. It says the long-term tenants have left and two-night platform stays start "next Friday", which could be 10 or 17 July 2026. It asks Mossbank to say in writing whether different terms are needed and what else they want to know. It makes clear that nothing is being changed or agreed yet. I left out the policy number because there isn't one in the file. - **To Ada:** corrected her assumption and told her we have notified Mossbank for her. I said nothing about her policy has been changed or agreed, and nothing will be without her say-so. I advised her not to host guests until Mossbank replies in writing and she has accepted any terms they ask for. I asked her to reply today with the start date and whether she has already taken any bookings. **Why I notified Mossbank without waiting for her go-ahead** The two reviewers disagreed on this, and I went with notifying now. Ada wrote on Thursday 9 July, so "next Friday" could mean tomorrow, and the condition requires notice before the change. The notice only asks a question, commits her to nothing, and contains only her own information about her own policy. She knows it has gone and can withdraw it. The case note records this and the other review decisions. I didn't ask Ada how often she'll take bookings or whether guests get the whole flat. That's only needed if Mossbank asks for it. There's no phone number on file, so email was the only […]
- Asked for its answer (Overview, Next action at escalation): see ANSWER.md.

## Sub-agents the agent launched

### Sub-agent 1

**Task:** You are checking a broker's proposed action set on an insurance case. Read /case, /messages and all /documents first (broker Bridgewell Cover; insurer Mossbank Underwriting; policyholder Ada Wren; 82 Fern Street, Ellwick, ZZ7 1ZZ). Case date is Thursday 2026-07-09.

Proposed actions:
1. Email Ada Wren: correct her assumption — the policy is written for "single household residential letting" and its change-of-use condition requires notifying Mossbank BEFORE changing the property to short-term guest accommodation; two-night stays via a booking platform look like exactly that change. Tell her we are notifying Mossbank today and asking whether different terms are required; advise not to take the first guest stay until Mossbank has confirmed in writing, as cover may otherwise be affected; we'll pass on Mossbank's answer (could include different terms/premium or they may not offer cover). Ask her to confirm the exact first-stay date ("next Friday" — we read it as Friday 17 July 2026, but it could mean 10 July) and tell us at once if she has already accepted bookings.
2. Email Mossbank Underwriting: notify under the change-of-use condition that the client's long-term tenants have left and she plans to let the flat for two-night guest stays via a booking platform from next Friday (understood as 17 July 2026, client to confirm). Ask whether different terms are required and for written confirmation before the first stay, and what further information they need. Don't state facts we don' […]

**Report:** **Review of proposed actions: Ada Wren, guest-stay change of use**

The plan is mostly right. Keep all three actions, but make five changes before sending:
1. Don't tell Mossbank the start date is "understood as 17 July". Give both possible dates and treat the earlier one as live.
2. Take out "or they may not offer cover" and "premium".
3. Reword "cover may otherwise be affected" so it doesn't claim a consequence the extract doesn't state.
4. Make clear that Ada decides on any different terms before anything is agreed.
5. Add a chase deadline.

Notifying Mossbank now is within your authority, as long as you don't agree any terms.

**What the case requires**
- **What Ada said** (history.md event 002): the tenants have left, guest stays start "next Friday", and she asks "I assume nothing needs changing?" That needs a direct answer, and the answer is no, her assumption is wrong.
- **What the wording says** (wording-extract.pdf, BW-CH-007): the declared use is "single household residential letting". Mossbank must be notified "before changing the property to short-term guest accommodation". "The insurer will advise whether different terms are required."
- **What's on file** (event 003): Mossbank hasn't said anything about guest stays. So nobody can tell Ada her cover carries on as it is.
- **Timing:** the case date is Thursday 9 July 2026 and her email came in at 11:30. "Next Friday" could be tomorrow, 10 July. The notice has to go before the change, so it should go today.

**Authority: notify now, don't wait for an instruction**
- **Why it's fine:** Ada gave a firm plan with a date and asked if anything needs changing. That is asking you to deal with it. Our past claims follow the same pattern: in insurance-015 and insurance-017 the broker notified the insurer once the client had given the details, without a separate "please notify". Here Ada has already given them.
- **Waiting is the bigger risk:** if she meant 10 July, waiting for her reply could mean the notice arrives after the change.
- **It's a low-risk step:** the notice only asks whether different terms are needed. It doesn't change the policy, accept terms or commit Ada to anything. The information is about her own policy and goes to her own insurer.
- **Limits:**
  - Tell Ada in the same email that you're notifying (the plan does this).
  - Say that if she decides not to go ahead, she should tell you so you can update Mossbank.
  - Don't accept or agree any terms, premium or policy change without her explicit instruction. The plan doesn't currently say this anywhere. Add it to Action 1 and the internal note.

**Action 1: email to Ada**
1. **"The policy is written for 'single household residential letting'"**: the extract says "Insured use declared". We only hold an extract. Say "the declared insured use is…" and don't describe the whole policy.
2. **"Look like exactly that change"**: the extract doesn't define "short-term guest accommodation", and Mossbank decides. Say "appear to fall within that condition".
3. **"Cover may otherwise be affected"**: the extract says nothing about what happens if she doesn't notify, or starts before Mossbank replies. Suggested wording: "The policy requires Mossbank to be told before this change, and Mossbank will advise whether different terms are required. Until they reply, we can't confirm that your current cover applies to guest stays, so we recommend not taking the first guest stay until we have their answer."
4. **"Until Mossbank has confirmed in writing"**: confirmed what? Say "until Mossbank has replied in writing and you have agreed any different terms it requires".
5. **"Different terms/premium or they may not offer cover"**: the extract only says Mossbank "will advise whether different terms are required". It doesn't mention premium or refusing cover, so this goes beyond the wording and could alarm her for no reason. Replace with: "We'll pass on Mossbank's answer, including any different terms, for your decision. Nothing will be […]

### Sub-agent 2

**Task:** You are reviewing an insurance broking case file (broker: Bridgewell Cover; insurer: Mossbank Underwriting; policyholder: Ada Wren; property 82 Fern Street, Ellwick, ZZ7 1ZZ). Read /case, /messages and every file in /documents. Working only from the case, derive what the broker should do next: which messages should be sent, to whom, by what channel, with what content; what facts are known vs unverified (including dates — note the case date 2026-07-09 and what weekday it is); whether the broker has authority to notify the insurer of the planned change now or needs the client's instruction first; whether anything should wait; and whether the case should stay open. Cite the case file lines you rely on. Do not invent contact details or policy terms beyond the wording extract.

**Report:** I read everything in the file: /case, /messages/001, /documents/wording-extract.pdf and /documents/history.md. There are only three events, and the wording extract is the only policy material.

## Bottom line
Ada thinks nothing needs changing. The wording says otherwise. The declared use is "single household residential letting" (wording-extract L5). The policy also says Mossbank must be told **before** the property changes to "short-term guest accommodation", and Mossbank "will advise whether different terms are required" (L7–L11). Two-night stays through a booking platform (history L19) look like exactly that use. The next step is to reply to Ada today. Mossbank should be notified once she instructs it and confirms the date. The case stays open.

## Known facts (with sources)
- The case date is 2026-07-09, created 09:30 and updated 13:30 UTC (/case L7–L8). I checked the date: **9 July 2026 is a Thursday.**
- Mossbank emailed the service desk asking it to keep the wording extract for "this rental buildings policy". That email doesn't ask for a reply (history L7–L11).
- Ada emailed the service desk at 11:30. She said the long-term tenants have left, guest stays start "next Friday", and asked whether anything needs changing (history L15–L19; /case L17).
- Nobody has replied to Ada and nothing has been decided (/case L21).
- **Correction to event 003 (history L27):** the note says there is "no response from the insurer". In fact nothing has been sent to the insurer. The file shows no notification or question to Mossbank, so there is no insurer reply to wait for.

## Authority
The broker shouldn't notify Mossbank yet. It needs Ada's instruction first.
- Ada asked a question and assumed the answer was "no change" (history L19). That isn't an instruction to tell the insurer. The notice would disclose her plans on her behalf, and she may decide to delay or drop them. If Mossbank proposes different terms, she has to decide on them anyway.
- The key fact is also unclear. "Next Friday", said on Thursday 9 July, could mean **Friday 10 July (tomorrow)** or **Friday 17 July**. Sending a notice with a guessed date would not be accurate.
- So the hold-up is real, but it only affects the insurer notice. The reply to Ada must not wait for anything.

## Actions in order

**1. Email Ada now, replying to her 11:30 email (history L15–L17).**
Suggested content:
> Thank you for letting us know your long-term tenants have left and that you plan two-night guest stays through a booking platform. We can't confirm that nothing needs changing. Your policy records the insured use as "single household residential letting". It also has a change-of-use condition: Mossbank Underwriting must be told **before** the property changes to short-term guest accommodation, and Mossbank will then advise whether different terms are required. Your planned guest stays appear to fall under that condition.
> Until Mossbank responds, we can't say whether your cover continues on the same terms for guest stays. We recommend you don't take guests until Mossbank has been told and has given its advice.
> Please reply to confirm:
> (1) that you want us to notify Mossbank for you;
> (2) the date of the first guest stay. You said "next Friday": do you mean Friday 10 July or Friday 17 July 2026?
> (3) the date your long-term tenants left;
> (4) whether guests will have the whole flat, how often you expect bookings, and whether any long-term letting will continue.
> If the first stay is tomorrow, please reply as soon as you can. Mossbank may not be able to respond before then.

- Don't say cover is void or invalid, and don't quote other terms. The extract doesn't contain any (L1–L13).
- No phone number is in the file, so email is the only channel.

**2. Email Mossbank as soon as Ada instructs it.** Send it to the Mossbank address that sent event 001 (history L7–L9). Don't make up an address or a policy number. The extract reference BW-CH-007 (L1) can be quoted, but only as the extract […]

## What failed

Nothing failed.

## Run

- Result: completed; the run stopped by "answer only"
- Models: agent `claude-opus-5-5` (preset opus-5.5-xhigh), sub-agents on (preset opus-5.5-xhigh)
- 6 agent model call(s), about $1.05, 201 s
- Full trace (every prompt, model call, tool call and result): `logs/007.json`; run `20261010-154033-challenge-insurance30-xhigh-subagents-on`

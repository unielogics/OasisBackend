# 0124 Opt-out keywords, and the questions the owner has to answer about CANCEL and Spanish replies
Status: accepted for the added keywords (2026-10-08); **CANCEL and Spanish keywords: decision needed from the owner**

## What changed

`src/modules/messaging/inbound/keywords.ts` now treats **REVOKE**, **OPT OUT** / **OPTOUT** and **STOP ALL** as opt-outs, in
any case, with surrounding punctuation, and with the two-word forms written together or with spaces, a hyphen, an underscore or
a dot between the words ("Opt-Out", "opt out.", "STOP  ALL!"). The rule stays "the keyword is the whole message": "please opt me
out", "opt out of the wax please" and "revoke my booking" are messages for staff, not keywords (staff see them as a new reply).
The stored keyword is canonical (`OPTOUT`, `STOPALL`, `REVOKE`). Nothing else about opt-out handling changed (the number is
opted out, one confirmation text is sent, queued texts to the number are cancelled, a stranger's opt-out is honoured too).

**CANCEL was deliberately not changed.** In this system a bare "CANCEL" reply means "cancel my appointment": it is stored as a
message, raises the red "Cancel request" alert on the Operations board for staff, and does **not** opt the number out.

## Why the owner has to decide (not legal advice)

The FCC's revocation-of-consent order under the TCPA (Report and Order FCC 24-24, CG Docket 02-278, adopted February 2024; most
rules in force since April 11, 2025) says, in short:

* a consumer may revoke consent to calls and texts **by any reasonable means**, and a business cannot make its own method the only
  one;
* a reply text using the words **"stop", "quit", "end", "revoke", "opt out", "cancel" or "unsubscribe"** is treated as a
  reasonable, definitive revocation; other wording is judged on the totality of the circumstances;
* revocation must be honoured within a reasonable time, at most ten business days, and one confirmation text (no marketing)
  may be sent within five minutes;
* a separate rule that a revocation covers every unrelated message from the same sender had its effective date postponed (first
  to April 2026); check its current status before relying on either reading.

Two consequences for Oasis:

1. **CANCEL.** The order lists "cancel" among the revocation words, and this system reads it as an appointment cancellation that
   keeps texting the customer. If a customer who replied CANCEL keeps receiving texts (a reminder, a "your vehicle is ready"), that
   is the exposure the order describes (statutory damages are per message).
2. **Spanish.** ALTO, PARAR, BAJA (and CANCELAR, NO MÁS) are not keywords today: they reach staff as an ordinary reply and the
   customer stays opted in. The order's list is English words; whether a Spanish "stop" sent to a business that texts in English is
   a "reasonable means" is not settled by the list, but a customer writing ALTO plainly wants the texts to stop, and the cost of
   honouring it is small.

## Current behaviour, exactly

| Reply | Today |
|---|---|
| STOP, STOPALL / STOP ALL, UNSUBSCRIBE, END, QUIT, REVOKE, OPTOUT / OPT OUT | opt-out (number blocked, confirmation sent, queue cancelled) |
| START, UNSTOP; YES when opted out | opt back in |
| CANCEL | **not** an opt-out: stored, red "Cancel request" alert for staff, customer keeps getting texts |
| ALTO, PARAR, BAJA, CANCELAR | **not** keywords: stored as a reply for staff |
| HELP | help reply |
| C, CONFIRM; YES with a booking waiting | confirm the appointment |

## Options for CANCEL

* **A. Keep it (today).** Staff see the cancel request; texting continues. Matches the design's workflow; carries the risk above.
* **B. CANCEL opts out and still raises the cancel request (recommended to discuss).** The number is opted out at once, the
  confirmation says texts have stopped and how to restart (START), and staff still get the red alert to cancel the appointment
  and call the customer. The customer loses appointment texts until they reply START. One code change in `parseKeyword` plus a
  router branch that does both.
* **C. CANCEL opts out; appointment cancellations move to another word** (for example "CANCEL APPT", or a call or the reschedule
  page once it exists), with every appointment text saying so. Cleanest legally; changes the design's copy.
* **D. Ask first** (reply "Do you want to cancel your appointment or stop texts?"). Not recommended: the order allows one
  confirmation of the opt-out's scope, not a question that delays honouring it.

## Options for Spanish

* **A. Keep them as replies for staff (today).** Staff must opt the customer out by hand.
* **B. Treat ALTO, PARAR, BAJA (and CANCELAR under the CANCEL decision) as opt-outs** with the English confirmation.
* **C. B with a Spanish confirmation text** ("Ya no recibirás mensajes de Oasis Auto Spa. Responde START para volver a
  suscribirte."), which needs a template and the owner's approved wording.

Both choices are one-line changes in `keywords.ts` with tests in `test/messaging/opt-out-keywords.test.ts`; the router, the
opt-out store and the queue cancellation already handle any opt-out keyword. Confirm the decision with counsel familiar with the
TCPA before changing CANCEL.

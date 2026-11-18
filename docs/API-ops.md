# SONU ops API (imports, work requests, dashboard, jobs, exports)

All routes are under `/api`, need a session cookie, and are tenant-scoped (another contractor's record → 404). Mutating requests need `X-Requested-With: sonu`. Errors look like `{ error: { code, message, details? } }`. Dates from Marafiq are `YYYY-MM-DD`; "today" is in the contractor's time zone.

**Scope.** Coordinator, manager, contractor_admin and purchasing see every WR. A supervisor or foreman sees the WRs of his work teams plus the WRs he owns or has a job on. A technician sees only WRs with a job assigned to him. Technicians never get `requestor`, `estimatedTotalCost` or the money trail.

## Imports

| Route | Roles | Request | Response |
|---|---|---|---|
| `POST /imports` | coord, mgr, admin | multipart `file` (.xlsx/.xls), optional `listKey` | 201 `{ ok, batchId, listKey, rowsRead, new, changed, gone, events, unchanged, warnings[] }`. 422 `{ error: { code: missing_caption \| unknown_file \| empty \| unknown_list, message, details: { batchId, listKey, missingCaptions[], candidates[] } } }`. When a file is refused, nothing is loaded except a failed `import_batch` row. |
| `GET /imports?limit&listKey` | coord, mgr, admin | | `{ items: [{ id, listKey, title, source, fileName, status, result: ok\|unchanged\|failed, error, rowsRead, new, changed, gone, events, warnings, user:{id,fullName}, createdAt }] }` |
| `GET /imports/expected` | coord, mgr, admin | | `{ items: [{ key, title, menuPath, lastImportAt, rows, lastBatchId }] }` (all 11 lists) |
| `GET /data-as-of` | any | | `{ overall, lists: { <listKey>: time\|null } }` |
| `POST /imports/tracker` | coord, mgr, admin | multipart `file` (tracker workbook) | 201 `{ id, fileName, rows, matched, matchedItems[{wrCode,status,rawStatus,fcRemarks,current}], unknownWrCodes[], unknownStatuses[{value,count,candidates,suggested}], mappedStatuses[] }` |
| `POST /imports/tracker/confirm/:id` | coord, mgr, admin | `{ statusMap?: { "<raw text>": "<one of the 15>" } }` | `{ ok, written }`. Calling it a second time gives 409; upload the file again to re-run. |

## Work requests

| Route | Roles | Request | Response |
|---|---|---|---|
| `GET /work-requests` | all | query: `q, zone, discipline, facility, wrStatus, contractorStatus, owner(uuid\|none), criterion, tdStatus, kpi, ageBucket, rfeTimeFrame(kind), workTeam, qfStage, breach(0\|1\|2), unowned=1, mine=1, includeGone=1, sort, dir, page, pageSize≤2000` (comma lists allowed) | `{ today, rfeLimitDays, total, page, pageSize, items: WR[] }` |
| `GET /work-requests/:code` | all (scoped) | | `WR + { marafiqUrl, timeline[{kind,at,type,source,payload,userName}], assignments[], attachments[], rfe, rfeComments[], permit, moneyTrail, localPurchases[], materialRequests[{id,mrNo,mrCode,status,dateRequested,lines,requestedByName}] }` |
| `PATCH /work-requests/:code` | supervisor, foreman, coord, mgr, admin | `{ takeOwnership?: true, ownerId?: uuid\|null (coord+), criterion?: 1–4\|null, contractorStatus?: one of 15\|null, fcRemarks? }` | `WR` |
| `POST /work-requests/bulk` | coord, mgr, admin | `{ codes[], ownerId?, criterion? }` | `{ updated, notFound[] }` |
| `GET /meta` | all | | `{ contractorStatuses, roles, criteria, ageBuckets, kpis, tdStatuses, rfeTimeFrameKinds, qfStages, lookups:{zones,facilities,disciplines}, workTeams, people, lists }` |

`WR` = `{ id, wrCode, wrStatus, descriptiveStatus, qfStage, ptwCode, ptwStatus, requestor?, siteCode, siteName, buildingCode, buildingName, floorCode, roomCode, problemType, workTeamCode, priority, description, dateRequested, targetDate, dateTradeAssigned, estimatedTotalCost?, withRfe, progressPct, goneAt, internal:{ ownerId, ownerName, criterion, contractorStatus, fcRemarks, statusSource, dueAt, breachLevel }, computed:{ month, daysToBreach, tdStatus, kpi, rfeSubmittedOn, rfeApprovedOn, discipline, facility, zone, rfeStatus, daysSinceRequested, rfeTimeFrame, rfeTimeFrameKind }, deadline:{ ruleKey, ruleName, stage, dayNumber, limit, state, dueDate, warningsDue, breached }\|null, suggestedStatus:{status,reason}\|null }`.

## Material requests and procurement

The contractor's "MATERIALS / SERVICE REQUEST" form. Status flow: `submitted` (New) -> `accepted` (Pending) -> `enquiry` (Vendor enquiry sent) -> `quoted` (Quotation received) -> `ordered` -> `delivered` -> `closed`; also `rejected` (procurement, note required, only before `ordered`) and `cancelled` (requester, only while `submitted`). Moves go forward by one or more steps (procurement may skip); `closed` only follows `delivered`. An illegal move gives 409; a legal move the caller's role may not make gives 403. Every change writes a history row, an audit row and, when the MR has a work request, a `mr.submitted` / `mr.status` event on the WR timeline. SONU never writes to Marafiq.

Roles: raise / edit while `submitted` / cancel = supervisor, foreman (the WR must be in their zone, otherwise 404), coordinator, manager, contractor admin (editing needs the requester or a coordinator+). Procurement = purchasing, coordinator, manager, contractor admin. Viewing: the requester; supervisor/foreman see MRs of WRs in their scope; purchasing and coordinator+ see all of the company. Technicians and platform admins get 403. `quotedAmount` is null for roles that do not see money.

| Route | Roles | Request / response |
|---|---|---|
| `POST /mr` | raisers | `{ wrCode?, dateRequested?, projectName?, contractNo?, itemDiscipline?, facility?, zone?, buildingName?, purchaseType: materials\|services, purpose: stock\|new, additionalRequirements?, docsRequired?: (quote\|warranty\|client_approval\|calibration_certificate\|other)[], lines[1-50]: { description, quantity>0, uom?, brand?, storeSlNo?, clientMatRef?, kind?: material\|service, vendorOrigin?: local\|foreign, claimable?: bool, targetDate?, remarks?, wrCode? } }` -> 201 detail. `wrCode` is required for supervisor/foreman. Missing discipline / facility / zone / building are filled from the WR. `mr_no` is numbered per company ("MR-12"). Notifies all active purchasing users (`mr.submitted`, link `/procurement/mr/<id>`) |
| `GET /mr?status=&wr=&mine=1&overdue=1&q=` | viewers | `status` is a comma list. `q` matches MR no, WR code or a line description. `{ today, items[{ id, mrNo, mrCode, status, statusLabel, wrCode, dateRequested, purchaseType, purpose, lines, firstDescription, facility, buildingName, requestedByName, assignedToName, vendorName, quotedAmount, expectedDelivery, overdue, updatedAt }] }` (newest first, max 500) |
| `GET /mr/:id` | viewers | header + `lines[{ id, lineNo, wrCode, storeSlNo, clientMatRef, description, quantity, uom, brand, kind, vendorOrigin, claimable, targetDate, remarks, photos[{id,fileName,mime}] }]`, `history[{ fromStatus, toStatus, note, at, userName }]`, `documents[{ id, fileName, mime, docKind, createdAt, uploadedByName }]`, `can{ edit, cancel, procure, upload, nextStatuses[] }` |
| `PATCH /mr/:id` | requester or coordinator+ | any header field and/or `lines[]` (lines with `id` are updated, lines without are added, missing ones are deleted with their photos, numbering follows the order). Only while `submitted`, otherwise 409 |
| `POST /mr/:id/status` | see above | `{ to, note? }`. Accepting an unassigned MR assigns it to the caller. Notifies the requester (`mr.status`) unless he made the change |
| `PATCH /mr/:id/procurement` | purchasing, coordinator+ | `{ assignedTo?: uuid\|null (active purchasing/coordinator/manager/admin), vendorName?, vendorContact?, quotationRef?, quotedAmount?, expectedDelivery?, procurementRemarks? }`; 409 once rejected or cancelled |
| `POST /mr/:id/attachments` | requester, procurement | multipart: `kind=line` + `lineId` (photos: JPEG/PNG/WebP, max 6 per line) or `kind=doc` + `docKind` (images or PDF checked by `%PDF-`, max 20 per MR); up to 6 files of 10 MB each; 415 for any other type; 409 once closed, rejected or cancelled -> 201 `{ attachments[] }` |
| `DELETE /mr/:id/attachments/:attId` | uploader or coordinator+ | `{ ok: true }` |
| `GET /procurement/summary` | viewers (scoped) | `{ new, pending, enquiry, quoted, ordered, delivered, closedThisMonth, rejected, overdue }`. `overdue` = MRs not yet delivered, closed, rejected or cancelled that have a line with a `targetDate` before today |

`GET /attachments/:id` decides `mr_line` / `mr_doc` files by the MR rules alone (a file of an MR without a work request is visible only to people who can see the MR).

## Dashboard, my work, exports

| Route | Roles | Response |
|---|---|---|
| `GET /dashboard` | all except technician (scoped) | core `summarise` output (`totalOutstanding, breached, backlogKpi, averageAge, byDiscipline, byZone, byFacility, byYear, ageBuckets, kpiSplit, tdSplit, rfeTimeFrameSplit`) plus `descriptiveStages` (`[{stage 2–8,label,count}]`, or `null` until a WR Dashboard list has been imported), `needsActionToday{ deadlinesToday[], unowned[], returns[], …Count, unansweredComments }` and `dataAsOf{at,by,listKey}` |
| `GET /my-work` | all except technician | `{ today, owned, groups:{ take_ownership, returned, answer_qf, classify, estimate_due, assign_technician, other } }`. Each card is `{ wrCode, buildingName, roomCode, description, dayCounter{day,limit,state,dueDate,rule}, … }` |
| `GET /exports/master.xlsx` | supervisor, purchasing, coord, mgr, admin | Master workbook in the tracker layout (audited) |
| `POST /work-requests/:code/rfe-file` | same | body `{ lines:[{lineType?,vendorItemName,uom,lineNumber,poNumber,bpaItem,accountCode,estQty,unitPrice,markUp}], lineTypeStyle? }` → `rfe-<code>.xlsx`; 422 `details.problems[{line,field,message}]` |

## Field jobs

| Route | Roles | Request / response |
|---|---|---|
| `POST /work-requests/:code/assignments` | supervisor (own zone), coord, mgr, admin | `{ assigneeId (active technician/foreman), plannedDate?, hoursPlanned?, note? }` → 201 `Job`; notifies the assignee (`job.assigned`, link `/my-jobs/<id>`) |
| `GET /my-jobs` | all | `{ today, todayJobs[], open[], doneRecently[] }` |
| `GET /team-jobs?status=open\|assigned\|started\|done` | foreman (his team), supervisor (his zones), coord+ | `{ items: Job[] }` |
| `GET /jobs/:id` | assignee, foreman, supervisor, coord+ | `Job + { canAct, updates[{id,note,statusTo,at,userName,attachments[]}] }` |
| `POST /jobs/:id/start` | assignee or his foreman | assigned → started, otherwise 409 |
| `POST /jobs/:id/updates` | same, job must be started | multipart `note` + up to 6 photos (JPEG/PNG/WebP checked by their first bytes, 10 MB each; anything else gives 415) → 201 `{ id, attachments[] }` |
| `POST /jobs/:id/done` | same | JSON `{note}` or multipart with photos; started → done; notifies the supervisor (`job.done`) |
| `GET /attachments/:id` | anyone who can see the job/WR | streams the file (`Content-Disposition: inline`, `nosniff`) |

`Job` = `{ id, status, plannedDate, note, createdAt, startedAt, doneAt, assignee{id,fullName}, assignedBy, wr{ code, siteName, buildingCode, buildingName, floorCode, roomCode, description, problemType, priority, workTeamCode, ptwCode, ptwStatus, permitDateUpto } }`.

## Server functions

- `runImport(app, { contractorId, buffer, fileName, listKey?, userId?, syncRunId? })` takes a file through the same import path a manual upload uses.
- `runDeadlineSweep(app, contractorId?)` checks the deadlines. It runs every 15 minutes, but not when `NODE_ENV=test` or `SONU_DEADLINE_SWEEP=off`.
- "Today" can be fixed: set `app.opsClock.today = 'YYYY-MM-DD'`, or the env `SONU_TODAY` (ignored in production).

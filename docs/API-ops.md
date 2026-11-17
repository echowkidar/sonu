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
| `GET /work-requests/:code` | all (scoped) | | `WR + { marafiqUrl, timeline[{kind,at,type,source,payload,userName}], assignments[], attachments[], rfe, rfeComments[], permit, moneyTrail }` |
| `PATCH /work-requests/:code` | supervisor, foreman, coord, mgr, admin | `{ takeOwnership?: true, ownerId?: uuid\|null (coord+), criterion?: 1–4\|null, contractorStatus?: one of 15\|null, fcRemarks? }` | `WR` |
| `POST /work-requests/bulk` | coord, mgr, admin | `{ codes[], ownerId?, criterion? }` | `{ updated, notFound[] }` |
| `GET /meta` | all | | `{ contractorStatuses, roles, criteria, ageBuckets, kpis, tdStatuses, rfeTimeFrameKinds, qfStages, lookups:{zones,facilities,disciplines}, workTeams, people, lists }` |

`WR` = `{ id, wrCode, wrStatus, descriptiveStatus, qfStage, ptwCode, ptwStatus, requestor?, siteCode, siteName, buildingCode, buildingName, floorCode, roomCode, problemType, workTeamCode, priority, description, dateRequested, targetDate, dateTradeAssigned, estimatedTotalCost?, withRfe, progressPct, goneAt, internal:{ ownerId, ownerName, criterion, contractorStatus, fcRemarks, statusSource, dueAt, breachLevel }, computed:{ month, daysToBreach, tdStatus, kpi, rfeSubmittedOn, rfeApprovedOn, discipline, facility, zone, rfeStatus, daysSinceRequested, rfeTimeFrame, rfeTimeFrameKind }, deadline:{ ruleKey, ruleName, stage, dayNumber, limit, state, dueDate, warningsDue, breached }\|null, suggestedStatus:{status,reason}\|null }`.

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

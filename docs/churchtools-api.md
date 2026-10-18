# ChurchTools API: what the spec leaves out

The instance's OpenAPI spec (`ct_get_operation`) is the reference. These behaviours are missing from it or
contradict the obvious guess, seen on ChurchTools 3.137.1. The live suite (`test/live/`) proves the ones the
code relies on: when a live case fails, fix the fact here and the code that relies on it.

## Any endpoint

- **Info.** `GET /info` answers `{ version, build, siteName, ... }` without the `data` envelope of other
  endpoints. The spec defines no answer schema.
- **Page size.** `limit` caps differ per endpoint: `/persons` takes 500, `/groups` and
  `/groups/{groupId}/members` take 200 and answer 400 above it.
- **Date ranges.** `GET /calendars/appointments` includes the `to` day: `from` and `to` on the same day
  read that day. `GET /events` leaves the `to` day out, so `ct_list_events` sends the day after.

## Persons and groups

- **Person search.** `GET /persons?query=` matches one field only. A full-name search filters `firstName`
  and `lastName`, as the duplicate check in `src/tools/persons.ts` does.
- **Person create.** `POST /persons` marks only `departmentIds` as required, but an instance can refuse a
  person without `statusId`, `campusId` and the three `privacyPolicyAgreement*` fields.
- **Group category delete.** `DELETE /group/groupcategories/{id}` demands `dryRun=false` in the query,
  though the spec makes it optional.

## Appointments and events

- **Appointment update.** `PUT /calendars/{calendarId}/appointments/{appointmentId}` replaces the whole
  appointment: send every stored field, `null` ones included, with the changes, and without the deprecated
  aliases (`caption`, `information`, ...).
- **Event create.** Events have no `POST`. An appointment creates them from a template of its calendar
  (`GET /eventtemplates`): `events: [{ eventTemplateId, startDate }]` in the appointment's create body,
  which `ct_create_appointment` takes in `fields`. Deleting the appointment deletes its events.
- **Event services.** `DELETE /events/{eventId}/eventservices/{eventServiceId}` removes the service slot
  itself. To free an assignment, decline it: `POST /events/{eventId}/servicerequests/{eventServiceId}/decline`.
- **Event service path.** In `PUT /events/{eventId}/eventservices/{serviceId}` the last parameter is the
  assignment's eventServiceId, though the spec names it serviceId.
- **New assignment id.** Filling an event service (`PUT .../servicerequests/{id}` or
  `PUT .../eventservices/{id}`) gives the filled assignment a new id; the old one disappears from
  `GET /events/{eventId}`. Find it again by `serviceId` and assignee.

## Coverage tools (spec-checked 2026-10)

- **Modern service requests.** `PUT /events/{eventId}/servicerequests/{requestId}` (plus its
  `/accept`, `/decline` and `/undo` POSTs) is the non-deprecated path; `ct_assign_event_service`
  already used it. The deprecated `PUT .../eventservices/{serviceId}` remains only in
  `ct_set_external_event_service`, whose `agreed` flag has no verified modern equivalent in the
  curated flow, so it is kept and guarded like before instead of silently changing behaviour.
- **Booking conflicts.** `POST /bookings/conflicts` only determines conflicts and creates
  nothing, so booking plans call it for their preview and `ct_check_booking_conflicts` exposes
  it as a read-style check.
- **No `POST /events`.** The spec defines only `GET /events`; events are created through an
  appointment with an event template (see above). Nothing invents a create endpoint.
- **Not exposed.** Finance (129 operations), "Hidden" operations (81) and the legacy API are
  deliberately without tools, as are person login tokens, passwords, 2FA, privacy consent and
  merges.

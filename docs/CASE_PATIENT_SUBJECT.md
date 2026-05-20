# Case, Contact, and PatientSubject Contract

This runtime distinguishes who is messaging from who receives care.

## Core distinctions

- **Contact** is the messenger (the person writing to front desk).
- **PatientSubject** is who the case is about.
- **Case** groups one concrete operational topic/request.
- **Appointment** belongs to a specific Case and PatientSubject.

This allows runtime logic to stay safe when someone writes on behalf of another person.

## Why this boundary matters

A contact is not always the patient. For example, a parent can write for a child, or a partner can ask about post-booking details.

By separating `contact_id` and `patient_subject`, policy/executor layers can avoid unsafe assumptions while keeping execution deterministic.

## Example scenarios

1. **Self booking**
   - Contact writes for themselves.
   - `patient_subject.type = "self"`

2. **Boyfriend comes with patient**
   - Contact is a partner asking about attendance/logistics.
   - `patient_subject.type = "partner"`

3. **Brother needs filling**
   - Contact writes about sibling treatment needs.
   - `patient_subject.type = "sibling"`

4. **Child / Sofia appointment**
   - Contact books for a child named Sofia.
   - `patient_subject.type = "child"`
   - `patient_subject.display_name = "Sofia"`

5. **Post-booking question**
   - Contact asks about an already scheduled appointment.
   - Case type can be `post_booking` while still keeping patient subject explicit.

## Authority boundary

The contract also defines an authority decision layer:

- `system_can_answer`
- `needs_business_truth`
- `needs_human_authority`

This keeps medical conclusions, disputes, and high-risk topics from being auto-answered without the right source of truth or human authority.

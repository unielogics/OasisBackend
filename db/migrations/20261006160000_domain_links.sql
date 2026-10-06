-- Adds the foreign keys that the domain_core migration left out because the people/auth tables arrived on another branch.
-- Each constraint is added NOT VALID then validated, so the migration is safe on a populated database.
-- Still deferred (tables not built yet): appointments.membership_id, appointments.standing_series_id, emergency_notifications.message_id.

alter table appointments add constraint appointments_assigned_employee_id_fk foreign key (assigned_employee_id) references employees(id) on delete set null not valid;
alter table appointments validate constraint appointments_assigned_employee_id_fk;
alter table appointment_overrides add constraint appointment_overrides_employee_id_fk foreign key (employee_id) references employees(id) on delete set null not valid;
alter table appointment_overrides validate constraint appointment_overrides_employee_id_fk;
alter table job_checklist_items add constraint job_checklist_items_done_by_employee_id_fk foreign key (done_by_employee_id) references employees(id) on delete set null not valid;
alter table job_checklist_items validate constraint job_checklist_items_done_by_employee_id_fk;
alter table appointments add constraint appointments_created_by_fk foreign key (created_by) references users(id) on delete set null not valid;
alter table appointments validate constraint appointments_created_by_fk;
alter table appointment_addons add constraint appointment_addons_added_by_fk foreign key (added_by) references users(id) on delete set null not valid;
alter table appointment_addons validate constraint appointment_addons_added_by_fk;
alter table appointment_photos add constraint appointment_photos_uploaded_by_fk foreign key (uploaded_by) references users(id) on delete set null not valid;
alter table appointment_photos validate constraint appointment_photos_uploaded_by_fk;
alter table closures add constraint closures_created_by_fk foreign key (created_by) references users(id) on delete set null not valid;
alter table closures validate constraint closures_created_by_fk;
alter table emergency_closures add constraint emergency_closures_started_by_fk foreign key (started_by) references users(id) on delete set null not valid;
alter table emergency_closures validate constraint emergency_closures_started_by_fk;
alter table emergency_closures add constraint emergency_closures_reopened_by_fk foreign key (reopened_by) references users(id) on delete set null not valid;
alter table emergency_closures validate constraint emergency_closures_reopened_by_fk;
alter table vip_clients add constraint vip_clients_added_by_fk foreign key (added_by) references users(id) on delete set null not valid;
alter table vip_clients validate constraint vip_clients_added_by_fk;
alter table booking_rules add constraint booking_rules_updated_by_fk foreign key (updated_by) references users(id) on delete set null not valid;
alter table booking_rules validate constraint booking_rules_updated_by_fk;
alter table vip_settings add constraint vip_settings_updated_by_fk foreign key (updated_by) references users(id) on delete set null not valid;
alter table vip_settings validate constraint vip_settings_updated_by_fk;
alter table arrival_settings add constraint arrival_settings_updated_by_fk foreign key (updated_by) references users(id) on delete set null not valid;
alter table arrival_settings validate constraint arrival_settings_updated_by_fk;

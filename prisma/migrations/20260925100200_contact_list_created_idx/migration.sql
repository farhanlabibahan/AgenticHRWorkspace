-- Contacts list keyset (createdAt DESC, id DESC, read backward).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Contact_list_created_idx" ON "Contact"("orgId", "createdAt", "id");

import { afterAll, beforeAll, describe, expect, test } from "vitest";

const databaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.DCC_PROCESS_ROLE = "web";
process.env.DATABASE_URL = databaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
const integration = databaseUrl ? describe : describe.skip;
const { inTransaction, pool } = await import("@dcc/database");
const { lockTicketActor, ticketForActor } = await import("@dcc/domain");
const { migrate } = await import("../../../packages/database/src/migrate.ts");
const { setPublicTicketAttachments, setTicketAttachments } = await import("./ticket-uploads.ts");

integration("authenticated upload claims", () => {
  let project = "", otherProject = "", ticketId = "", otherTicket = "", formId = "";
  let reporter: any, editor: any, outsider: any;

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: databaseUrl! });
    const users = (await pool.query(`INSERT INTO users(username,password_hash,role) VALUES
      ('upload-owner','x','reporter'),('upload-editor','x','reporter'),('upload-outsider','x','reporter') RETURNING id ORDER BY username`)).rows;
    outsider = { userId: users[1].id, role: "reporter" };
    editor = { userId: users[0].id, role: "reporter" };
    reporter = { userId: users[2].id, role: "reporter" };
    const projects = (await pool.query(`INSERT INTO projects(slug,name,repository_path) VALUES
      ('upload-a','Upload A','/tmp/upload-a'),('upload-b','Upload B','/tmp/upload-b') RETURNING id ORDER BY slug`)).rows;
    [project, otherProject] = projects.map((row: any) => row.id);
    const forms = (await pool.query(`INSERT INTO forms(name,slug,title,status,fixed_project_id) VALUES
      ('Upload Form','upload-form','Upload Form','published',$1),('Other Form','other-form','Other Form','draft',$1) RETURNING id ORDER BY slug`, [project])).rows;
    formId = forms[1].id;
    await pool.query("INSERT INTO project_memberships(user_id,project_id) VALUES($1,$3),($2,$3),($4,$5)",
      [reporter.userId, editor.userId, project, outsider.userId, otherProject]);
    ticketId = (await pool.query("INSERT INTO tickets(ticket_number,project_id,title,description,status,created_by_user_id) VALUES('DCC-UPLOAD',$1,'Upload','Upload','Submitted',$2) RETURNING id", [project, reporter.userId])).rows[0].id;
    otherTicket = (await pool.query("INSERT INTO tickets(ticket_number,project_id,title,description,status,created_by_user_id) VALUES('DCC-UPLOAD-OTHER',$1,'Other','Other','Submitted',$2) RETURNING id", [project, reporter.userId])).rows[0].id;
  });
  afterAll(async () => pool.end());

  async function upload(owner = reporter.userId, projectId = project, options: { form?: string; age?: string; deadline?: string; status?: string; media?: string; ticket?: string } = {}) {
    const id = (await pool.query(
      `INSERT INTO uploads(storage_path,original_name,media_type,size_bytes,form_id,owner_user_id,project_id,claim_expires_at,created_at)
       VALUES('uploads/'||gen_random_uuid()||'.png','evidence.png',$1,8,$2,$3,$4,now()+($5)::interval,now()+($6)::interval) RETURNING id`,
      [options.media ?? "image/png", options.form ?? null, options.form ? null : owner, options.form ? null : projectId, options.deadline ?? "1 hour", options.age ?? "0 hours"],
    )).rows[0].id;
    await pool.query(`INSERT INTO artifacts(id,storage_path,artifact_type,status,sha256,finalized_at,expires_at,upload_id)
      SELECT gen_random_uuid(),storage_path,'upload',$2,CASE WHEN $2='finalized' THEN repeat('a',64) END,
      CASE WHEN $2='finalized' THEN now() END,CASE WHEN $2='staged' THEN now()+interval '1 hour' END,id FROM uploads WHERE id=$1`, [id, options.status ?? "finalized"]);
    await pool.query("INSERT INTO attachments(upload_id,ticket_id,field_key) VALUES($1,$2,$3)", [id, options.ticket ?? null, options.ticket ? "screenshots" : null]);
    return id;
  }

  async function claim(actor: any, ids: string[]) {
    return inTransaction(async (client) => {
      await lockTicketActor(client, actor);
      const ticket = await ticketForActor(client, actor, ticketId, true);
      await setTicketAttachments(client, actor, ticket, { screenshots: ids }, ["screenshots"]);
    });
  }

  async function publicUpload(form = formId) {
    return upload(reporter.userId, project, { form });
  }

  test("claims only finalized, fresh uploads owned by the actor and project", async () => {
    const valid = await upload();
    await expect(claim(reporter, [valid])).resolves.toBeUndefined();
    expect((await pool.query("SELECT ticket_id,claim_expires_at FROM attachments JOIN uploads ON uploads.id=attachments.upload_id WHERE upload_id=$1", [valid])).rows[0])
      .toMatchObject({ ticket_id: ticketId, claim_expires_at: null });

    for (const invalid of [
      await upload(editor.userId), await upload(reporter.userId, otherProject), await upload(reporter.userId, project, { age: "-2 hours" }),
      await upload(reporter.userId, project, { deadline: "-1 minute" }), await upload(reporter.userId, project, { status: "staged" }),
      await upload(reporter.userId, project, { media: "text/plain" }), await upload(reporter.userId, project, { ticket: otherTicket }),
    ]) {
      await expect(claim(reporter, [invalid])).rejects.toMatchObject({ status: 422 });
      expect((await pool.query("SELECT ticket_id FROM attachments WHERE upload_id=$1", [invalid])).rows[0].ticket_id).not.toBe(ticketId);
    }
  });

  test("rejects duplicates, undeclared fields and more than five images", async () => {
    const id = await upload();
    await expect(inTransaction(async (client) => setTicketAttachments(client, reporter, { id: ticketId, project_id: project }, { screenshots: [id], other: [id] }, ["screenshots"]))).rejects.toMatchObject({ status: 422 });
    const six = await Promise.all(Array.from({ length: 6 }, () => upload()));
    await expect(claim(reporter, six)).rejects.toMatchObject({ status: 422 });
  });

  test("an assigned editor may retain an existing image but cannot steal another ticket's image", async () => {
    const retained = await upload();
    await claim(reporter, [retained]);
    await expect(claim(editor, [retained])).resolves.toBeUndefined();
    const claimedElsewhere = await upload(reporter.userId, project, { ticket: otherTicket });
    await expect(claim(editor, [claimedElsewhere])).rejects.toMatchObject({ status: 422 });
  });

  test("keeps upload scopes separate and refuses the same public form after unpublishing", async () => {
    const publicId = await publicUpload();
    await expect(claim(reporter, [publicId])).rejects.toMatchObject({ status: 422 });
    const authenticatedId = await upload();
    await expect(inTransaction((client) => setPublicTicketAttachments(client, formId, ticketId,
      { screenshots: [authenticatedId] }, ["screenshots"]))).rejects.toMatchObject({ status: 422 });
    await pool.query("UPDATE forms SET status='draft' WHERE id=$1", [formId]);
    await expect(inTransaction((client) => setPublicTicketAttachments(client, formId, ticketId,
      { screenshots: [publicId] }, ["screenshots"]))).rejects.toMatchObject({ status: 404 });
    expect((await pool.query("SELECT ticket_id FROM attachments WHERE upload_id=ANY($1::uuid[]) ORDER BY upload_id", [[publicId, authenticatedId]])).rows)
      .toEqual([{ ticket_id: null }, { ticket_id: null }]);
  });

  test("validates all claims before mutating and detaches without deleting upload evidence", async () => {
    const retained = await upload();
    const detached = await upload();
    await claim(reporter, [retained, detached]);
    const unavailable = await upload(editor.userId);

    await expect(claim(reporter, [retained, unavailable])).rejects.toMatchObject({ status: 422 });
    expect((await pool.query("SELECT upload_id FROM attachments WHERE ticket_id=$1 ORDER BY upload_id", [ticketId])).rows.map((row: any) => row.upload_id).sort())
      .toEqual([retained, detached].sort());

    await claim(reporter, [retained]);
    expect(Number((await pool.query("SELECT count(*) FROM uploads u JOIN artifacts ar ON ar.upload_id=u.id WHERE u.id=$1", [detached])).rows[0].count)).toBe(1);
    expect((await pool.query("SELECT claim_expires_at FROM uploads WHERE id=$1", [detached])).rows[0].claim_expires_at).toBeNull();
  });
});

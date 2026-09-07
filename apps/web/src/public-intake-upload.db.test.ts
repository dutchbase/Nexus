import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
process.env.DCC_PROCESS_ROLE = "web";
process.env.DATABASE_URL = testDatabaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";
const integration = testDatabaseUrl ? describe : describe.skip;
const { pool } = await import("@dcc/database");
const { migrate } = await import("../../../packages/database/src/migrate.ts");
const { submitPublicForm } = await import("./server.ts");

integration("public upload claims", () => {
  let form: any, uploadId: string;
  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: testDatabaseUrl! });
    const projectId = (await pool.query("INSERT INTO projects (slug,name,repository_path) VALUES ('claim-test','Claim test','/tmp/claim-test') RETURNING id")).rows[0].id;
    form = (await pool.query("INSERT INTO forms (name,slug,title,status,fixed_project_id,settings_json) VALUES ('Claim','claim','Claim','published',$1,$2) RETURNING *", [projectId, { notify_on_submission: false }])).rows[0];
    await pool.query(`INSERT INTO form_fields (form_id,field_key,field_type,label,required,position) VALUES
      ($1,'title','short_text','Title',true,1),($1,'description','long_text','Description',true,2),($1,'evidence','image_upload','Evidence',true,3)`, [form.id]);
    uploadId = (await pool.query("INSERT INTO uploads (storage_path,original_name,media_type,size_bytes,form_id) VALUES ('uploads/evidence.png','evidence.png','image/png',8,$1) RETURNING id", [form.id])).rows[0].id;
    await pool.query("INSERT INTO artifacts (id,storage_path,artifact_type,status,sha256,finalized_at,upload_id) VALUES (gen_random_uuid(),'uploads/evidence.png','upload','finalized',$1,now(),$2)", ["a".repeat(64), uploadId]);
    await pool.query("INSERT INTO attachments (upload_id,field_key) VALUES ($1,'evidence')", [uploadId]);
  });
  afterAll(async () => { await pool.end(); });

  test("two concurrent submissions cannot both claim one upload", async () => {
    const request = () => ({ method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ title: "Race", description: "Race", evidence: [uploadId] }));
    } } as any);
    const response = () => ({ writeHead: vi.fn(), end: vi.fn() } as any);
    const first = response(), second = response();
    await Promise.all([submitPublicForm(request(), first, form), submitPublicForm(request(), second, form)]);
    expect([first.writeHead.mock.calls[0][0], second.writeHead.mock.calls[0][0]].sort()).toEqual([201, 400]);
    expect(Number((await pool.query("SELECT count(*) FROM tickets WHERE form_id=$1", [form.id])).rows[0].count)).toBe(1);
    expect((await pool.query("SELECT ticket_id FROM attachments WHERE upload_id=$1", [uploadId])).rows[0].ticket_id).toBeTruthy();
  });
});

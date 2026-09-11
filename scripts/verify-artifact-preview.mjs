import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "btp-preview-test-"));
process.env.STUDIO_WORKSPACE_ROOT = root;
const { readArtifactPreview } = await import("../apps/api/dist/workspaceWriter.js");
const projectId = "preview_test";
const projectRoot = join(root, projectId);
mkdirSync(join(projectRoot,"agents/art"),{recursive:true});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64");
function artifact(path) {
  return {artifactId:"preview",projectId,path,type:"asset",ownerAgentId:"art_director",status:"submitted",version:1,metadata:{},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
}
try {
  writeFileSync(join(projectRoot,"agents/art/board.png"),png);
  const result = readArtifactPreview(projectId,artifact("agents/art/board.png"));
  assert.equal(result.previewable,true);
  assert.equal(result.image.width,1);
  assert.equal(result.image.height,1);
  assert.equal(result.image.dataUrl,`data:image/png;base64,${png.toString("base64")}`);
  assert.equal(result.target.absolutePath,undefined,"response must not expose absolute host paths");
  writeFileSync(join(projectRoot,"agents/art/fake.png"),"<script>alert(1)</script>");
  assert.equal(readArtifactPreview(projectId,artifact("agents/art/fake.png")).previewable,false);
  writeFileSync(join(projectRoot,"agents/art/oversize.png"),Buffer.alloc(12*1024*1024+1));
  assert.equal(readArtifactPreview(projectId,artifact("agents/art/oversize.png")).previewable,false);
  writeFileSync(join(projectRoot,"agents/art/note.md"),"# Preview\n");
  assert.equal(readArtifactPreview(projectId,artifact("agents/art/note.md")).content,"# Preview\n");
  symlinkSync(join(root,"outside.png"),join(projectRoot,"agents/art/escape.png"));
  writeFileSync(join(root,"outside.png"),png);
  assert.throws(()=>readArtifactPreview(projectId,artifact("agents/art/escape.png")));
  console.log("Artifact preview regression passed: PNG, text, invalid/oversize and symlink rejection.");
} finally {rmSync(root,{recursive:true,force:true});}

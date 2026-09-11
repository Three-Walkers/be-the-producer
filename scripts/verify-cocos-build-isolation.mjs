import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withIsolatedCreatorMetadata } from "../apps/api/dist/cocosBuildIsolation.js";
const root = mkdtempSync(join(tmpdir(), "btp-creator-metadata-"));
const put = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
try {
  put("package.json", '{"name":"authored-project"}\n');
  put("assets/scenes/MainGame.scene.meta", '{"uuid":"authored-uuid"}\n');
  put("assets/scenes/MainGame.scene", '[{"name":"AuthoredScene"}]\n');
  put("assets/scripts/gameplay/Game.ts", "original source\n");
  put("settings/v2/packages/project.json", '{"orientation":"portrait"}\n');
  const mutate = () => {
    put("package.json", '{"name":"native-mutation"}');
    put("assets/scenes/MainGame.scene.meta", '{"uuid":"changed-uuid"}');
    put("assets/scenes/MainGame.scene", '[{"name":"NativeReserializedScene"}]');
    put("assets/scripts/gameplay/Game.ts.meta", '{"uuid":"new-meta"}');
    put("assets/scripts.meta", '{"uuid":"directory-meta"}');
    put("profiles/v2/editor/packages.json", '{"editor":"local-only"}');
    put("settings/v2/packages/builder.json", '{"cache":"temporary"}');
    unlinkSync(join(root, "settings/v2/packages/project.json"));
    put("shared/build-artifacts/wechat/dev/game.js", "actual build output\n");
  };
  for (const fails of [false, true]) {
    const execute = () => withIsolatedCreatorMetadata(root, () => { mutate(); if (fails) throw new Error("Creator failed"); return 36; });
    if (fails) assert.throws(execute, /Creator failed/); else assert.equal(execute(), 36);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), '{"name":"authored-project"}\n');
    assert.equal(readFileSync(join(root, "assets/scenes/MainGame.scene.meta"), "utf8"), '{"uuid":"authored-uuid"}\n');
    assert.equal(readFileSync(join(root, "assets/scenes/MainGame.scene"), "utf8"), '[{"name":"AuthoredScene"}]\n');
    assert.equal(readFileSync(join(root, "settings/v2/packages/project.json"), "utf8"), '{"orientation":"portrait"}\n');
    for (const path of ["assets/scripts.meta", "assets/scripts/gameplay/Game.ts.meta", "profiles/v2/editor/packages.json", "settings/v2/packages/builder.json"]) {
      assert.equal(existsSync(join(root, path)), false, `native auxiliary file must remain isolated: ${path}`);
    }
    assert.equal(readFileSync(join(root, "shared/build-artifacts/wechat/dev/game.js"), "utf8"), "actual build output\n");
  }
  withIsolatedCreatorMetadata(root, () => put("assets/scripts/gameplay/Game.ts", "unexpected source mutation\n"));
  assert.equal(readFileSync(join(root, "assets/scripts/gameplay/Game.ts"), "utf8"), "unexpected source mutation\n", "non-metadata source mutations stay visible to the outer fail-closed guard");
  symlinkSync(join(root, "package.json"), join(root, "assets/unsafe.meta"));
  assert.throws(() => withIsolatedCreatorMetadata(root, () => assert.fail("must reject before native execution")), /符号链接/);
  console.log("Creator build isolation passed: native metadata/config restore on success/failure, retained output, visible unexpected source edits, no symlink escape.");
} finally { rmSync(root, { recursive: true, force: true }); }

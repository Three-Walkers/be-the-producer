import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the generated platform bridge, not a reimplementation of its assembly
// loop. Model Cocos's synchronous onLoad when adding a component to an active
// hierarchy, and its deferred lifecycle for inactive roots.
export function verifyBootstrapLifecycle(source, descriptor) {
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true
  } }).outputText;
  for (const invalidReference of [false, true]) {
    const blueprint = structuredClone(descriptor);
    if (invalidReference) {
      blueprint.scenes[0].nodes.find((n) => n.nodeId === "controller").components[0].references[0].nodeId = "missing";
    }
    let loads = 0;
    class Component { isValid = true; }
    class Node {
      children = [];
      components = [];
      layer = 1;
      _active = true;
      constructor(name) { this.name = name; }
      get active() { return this._active; }
      set active(value) { this._active = value; this.activate(); }
      get activeInHierarchy() { return this._active && Boolean(this.sceneRoot || this.parent?.activeInHierarchy); }
      activate() {
        if (!this.activeInHierarchy) return;
        for (const component of this.components) {
          if (component.loaded) continue;
          component.loaded = true;
          component.onLoad?.();
        }
        for (const child of this.children) child.activate();
      }
      addChild(child) { child.parent = this; this.children.push(child); child.activate(); }
      addComponent(Type) {
        const component = new Type();
        component.node = this;
        this.components.push(component);
        this.activate();
        return component;
      }
      getComponent(Type) { return this.components.find((c) => c instanceof Type); }
      setPosition() {}
      setRotationFromEuler() {}
      setScale() {}
      setSiblingIndex(index) {
        const siblings = this.parent.children;
        siblings.splice(siblings.indexOf(this), 1);
        siblings.splice(index, 0, this);
      }
      destroy() { this.isValid = false; }
    }
    class UITransform extends Component { setContentSize() {} }
    class Sprite extends Component { static SizeMode = { CUSTOM: 0 }; }
    class Graphics extends Component { roundRect() {} fill() {} }
    class Label extends Component {}
    class Color { constructor(r, g, b, a) { Object.assign(this, { r, g, b, a }); } }
    class GameController extends Component {
      onLoad() {
        loads++;
        assert.equal(this.boardSize, 4, "onLoad must observe serialized properties");
        assert.equal(this.progressSignal, "moves", "onLoad must observe signal bindings");
        assert.equal(this.board_node?.name, "PuzzleBoard", "onLoad must observe resolved node references");
        const counter = this.board_node.children.find((n) => n.name === "MoveCounter");
        assert.equal(counter?.getComponent(Label)?.string, "Moves: 0", "onLoad must observe the fully configured descendant graph");
        assert.equal(this.node.__btpTestId, "puzzle_controller");
      }
    }
    const fixtureExports = {};
    const cc = {
      Component, Node, UITransform, Sprite, Graphics, Label, Color,
      Button: class extends Component {}, Camera: class extends Component {}, AudioSource: class extends Component {},
      JsonAsset: class {}, Texture2D: class {}, SpriteFrame: class {}, Vec3: class {},
      _decorator: { ccclass: () => (ctor) => ctor }, js: { setClassAlias() {} },
      view: { setDesignResolutionSize() {} }, ResolutionPolicy: { SHOW_ALL: 0 },
      resources: { load(path, _type, callback) {
        if (path === "btp/scene-blueprint") callback(null, { json: blueprint });
        else callback(new Error("fixture texture absent"));
      } }
    };
    runInNewContext(compiled, { exports: fixtureExports, console: { info() {}, warn() {}, error() {} },
      require: (id) => id === "cc" ? cc : { GameController } });
    const canvas = new Node("Canvas");
    canvas.sceneRoot = true;
    const bootstrap = new fixtureExports.BtpRuntimeBootstrap();
    bootstrap.node = canvas;
    if (invalidReference) {
      assert.throws(() => bootstrap.start(), /node reference was not materialized/);
      assert.equal(loads, 0, "failed assembly must not execute gameplay lifecycle");
      assert.ok(canvas.children.every((child) => !child.activeInHierarchy));
    } else {
      bootstrap.start();
      assert.equal(loads, 1, "activate the configured controller exactly once");
      assert.deepEqual(canvas.children.map((n) => n.name), ["PuzzleBoard", "PuzzleController"]);
      assert.ok(canvas.children.every((child) => child.activeInHierarchy));
    }
  }
}

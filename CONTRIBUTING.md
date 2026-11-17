# Contributing to Be The Producer

English and 简体中文 are both welcome. You can contribute by describing where a producer gets stuck, improving a translation, or changing how the studio works.

## Choose where to contribute

- For a reproducible bug, an accessibility barrier, or a specific feature request, [open an issue](https://github.com/Three-Walkers/be-the-producer/issues/new/choose).
- For questions or early game-studio ideas, [start a discussion](https://github.com/Three-Walkers/be-the-producer/discussions).
- For vulnerabilities, follow the [security policy](SECURITY.md). For community conduct, see the [code of conduct](CODE_OF_CONDUCT.md).

## Run the studio locally

Fork the repository, clone your fork, and create a branch. From the repository root, use Node.js 24 and npm to install dependencies and open the studio in your browser.

```sh
npm ci
npm start -- --open
```

The studio opens at `http://localhost:8787` by default. Press Ctrl+C in the terminal to stop it.

## Check and submit a change

The browser interface lives in `apps/api/public`, the server in `apps/api/src`, and the shared types and agent code in `packages`. For code changes, run `npm run typecheck` and a check that exercises what you changed. For example, run `npm run verify:dashboard-progress` for dashboard progress or `npm run verify:contracts` for game contracts. Run `npm run` to list the other checks.

Open a pull request against `main`. Describe the change from a producer’s perspective and include your verification steps. For documentation, check the affected links or example commands. For a change to gameplay or visuals, a short playtest description or a screenshot from a sample project helps reviewers reproduce it. Keep credentials and private project material out of examples. Credit the source and include applicable license notices when contributing third-party assets or code.

## 中文贡献指引

遇到制作流程卡住、界面难以操作，或有具体功能需求，可以用中文[提交 Issue](https://github.com/Three-Walkers/be-the-producer/issues/new/choose)。尚在探索的想法可放到 [Discussions](https://github.com/Three-Walkers/be-the-producer/discussions)。发现漏洞请使用[私密报告入口](SECURITY.md)。

Fork 并克隆仓库后，新建分支。在仓库根目录使用 Node.js 24 和 npm，依次执行上面的两条命令即可打开本地工作室。修改代码后，运行 `npm run typecheck` 和对应功能的检查。向 `main` 提交 PR 时，请写明制作人会看到什么变化、如何验证。截图和复现材料请使用示例项目，引用第三方素材或代码时请注明来源并保留许可声明。

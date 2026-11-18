# 第三方许可说明

本项目 Apache-2.0 许可仅适用于权利人拥有或获授权的原创部分，不覆盖第三方组件。

- Node.js 依赖 qrcode、ws 以及其传递依赖：锁定版本和许可标识见 package-lock.json（当前记录为 MIT 或 ISC）。已将当前安装依赖可找到的许可文本保留在 `third-party-licenses/`。实际分发依赖或容器时，仍须保留各包附带的 LICENSE / 版权声明。
- Android Gradle Wrapper：Gradle 项目，Apache-2.0；JAR 内保留 META-INF/LICENSE。Gradle：https://gradle.org/ 。
- Android Gradle Plugin、AndroidX、Material Components、ZXing Android Embedded 及传递依赖：由 Gradle 从上游取得，遵循各自发行版本的许可。构建 APK 时应收集并随发行物提供适用的第三方许可及 NOTICE，不应仅凭本文件视为完成二进制分发合规。
- JDK、Android SDK、基础容器镜像和工具链受各自条款约束，不因本仓库许可改变。

本清单是源码依赖提示，不是完整的法律权属审计，也不是所有未来构建产物的完整软件物料清单。未发现许可证的素材不得自行推定为 Apache-2.0；新增外部代码或素材时请记录来源并保留上游声明。

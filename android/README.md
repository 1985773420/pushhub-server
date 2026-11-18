# PushHub Android 客户端

与本仓库根目录的 PushHub Server 配套使用，支持扫码配对、WebSocket 推送、消息历史、通知及富媒体附件。当前源码版本为 1.8.0（versionCode 11），最低 Android 8.0 / API 26。

## 构建环境

- JDK 17
- Android SDK Platform 36（compileSdk 36；targetSdk 34）
- Gradle 8.11.1、Android Gradle Plugin 8.10.1
- 首次构建需要联网下载 Google Maven / Maven Central 依赖。

推荐使用兼容 AGP 8.10.1 的 Android Studio 打开本目录，让 IDE 配置 SDK。也可以安装上述 SDK 和 Gradle，在本目录运行：

```bash
export ANDROID_HOME=/你的/Android/sdk
# 配置 PATH，使 gradle 指向 8.11.1
gradle --no-daemon :app:assembleDebug
```

调试 APK：`app/build/outputs/apk/debug/app-debug.apk`。调试包名为 `com.pushhub.app.debug`，与正式版不同，可并存。仓库保留 Gradle wrapper 配置和 JAR；如果需要标准启动脚本，可以用已安装的 Gradle 执行 `gradle wrapper --gradle-version 8.11.1` 生成。

## 正式版签名

正式版包名为 `com.pushhub.app`。本仓库不包含原发布者的签名密钥或密码，不能用新密钥覆盖安装旧签名的正式版。

请自行创建并安全备份密钥，例如在本目录执行：

```bash
keytool -genkeypair -keystore app/release.jks -alias pushhub \
  -keyalg RSA -keysize 3072 -validity 10000
```

按提示输入你自己的密码；不要将密码写进命令行。然后在未跟踪的 `keystore.properties` 中填写：

```properties
PUSH_RELEASE_STORE_FILE=release.jks
PUSH_RELEASE_STORE_PASSWORD=填写你的密钥库密码
PUSH_RELEASE_KEY_ALIAS=pushhub
PUSH_RELEASE_KEY_PASSWORD=填写你的私钥密码
```

路径相对于 `app/`。也支持通过同名环境变量传入这些配置。构建：

```bash
gradle --no-daemon :app:assembleRelease
```

产物在 `app/build/outputs/apk/release/`。今后升级必须沿用同一密钥并提高 versionCode。不要提交 `*.jks`、`*.keystore` 或 `keystore.properties`。

## 安装与配对

1. 构建 APK 后传到手机安装，或使用 `adb install app/build/outputs/apk/debug/app-debug.apk`。
2. 先部署本仓库根目录的服务端，并确认手机能访问它。
3. 在服务端控制台配置内网或公网配对地址，生成一次性二维码。
4. 打开客户端扫码配对，按系统提示授予相机和通知权限。
5. 在服务端发送测试消息，检查手机通知、消息列表和设备在线状态。

管理员令牌只用于服务端控制台，客户端通过配对获取独立设备令牌，不应向客户端填入管理员密钥。

## 后台运行与安全

- 允许通知、后台活动、自启动；按手机厂商要求调整电池优化。前台服务及重连机制不能保证在强制停止、断网或厂商限制下持续送达。
- 项目允许明文 HTTP 以适应局域网部署。公网务必使用 HTTPS / WSS，并确保代理支持 WebSocket。
- 部分设备请求使用 URL 参数携带设备令牌，应避免记录完整 URL，并限制代理日志及备份的访问权限。
- 手机保存配对信息与消息历史；不要分享应用私有数据、备份或含配对码的截图。
- 更换签名需卸载旧版本时，可能丢失本地记录并需要重新配对。

## 发布范围与验证

仅发布源码、资源和构建配置，不包含原签名密钥、本机 SDK 路径、私人代理、Gradle 缓存或历史 APK。构建成功不代表已在所有机型上测试后台通知；正式分发前请真机验证配对、通知权限、重连和附件展示。

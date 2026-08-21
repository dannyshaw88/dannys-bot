# Aura Native Filter Camera

This is the phone-side native CameraX filter surface. It runs locally on Android
and does not open Chrome or send camera frames through the web app.

## Build

With Android SDK and Gradle available:

```sh
cd artifacts/api-server/native-filter-camera
gradle assembleDebug
```

The API launches:
`app/build/outputs/apk/debug/app-debug.apk`

The native version provides a live front-camera preview, on-device ML Kit face
tracking, Off/Long hair/Beard/Cute face/Glasses/Freckles/Blush/Cartoon effects,
filtered still-photo capture, and local CameraX video capture to
`DCIM/AuraFilters`. The selected effect is persisted under the launching
device serial, so a filter choice on one connected phone does not bleed into
another phone.
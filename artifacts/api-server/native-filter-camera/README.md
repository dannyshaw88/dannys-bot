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

The first native version provides a live front-camera preview, on-device ML Kit
face tracking, Off/Glasses/Beard/Blush/Freckles/Cartoon effects, and filtered
still-photo capture to `DCIM/AuraFilters`. Video compositing remains separate
from still capture and is not silently presented as complete.
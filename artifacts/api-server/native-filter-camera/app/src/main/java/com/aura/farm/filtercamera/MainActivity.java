package com.aura.farm.filtercamera;

import android.Manifest;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.HorizontalScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.annotation.NonNull;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.camera.video.MediaStoreOutputOptions;
import androidx.camera.video.Quality;
import androidx.camera.video.QualitySelector;
import androidx.camera.video.Recorder;
import androidx.camera.video.Recording;
import androidx.camera.video.VideoCapture;
import androidx.camera.video.VideoRecordEvent;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;

import java.io.OutputStream;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native CameraX filter surface. Camera frames never leave the device. */
public final class MainActivity extends ComponentActivity {
    private static final int CAMERA_REQUEST = 42;
    private PreviewView preview;
    private FilterOverlay overlay;
    private ExecutorService cameraExecutor;
    private FaceDetector detector;
    private String filter = "Off";
    private String serial = "unknown";
    private Recording recording;
    private TextView status;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        cameraExecutor = Executors.newSingleThreadExecutor();
        serial = getIntent().getStringExtra("serial");
        if (serial == null || serial.trim().isEmpty()) serial = "unknown";
        filter = getPreferences(MODE_PRIVATE).getString("filter:" + serial, "Off");
        FaceDetectorOptions options = new FaceDetectorOptions.Builder()
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
                .enableTracking().build();
        detector = FaceDetection.getClient(options);
        buildUi();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO}, CAMERA_REQUEST);
        } else startCamera();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.BLACK);
        preview = new PreviewView(this);
        preview.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        overlay = new FilterOverlay(this);
        android.widget.FrameLayout cameraBox = new android.widget.FrameLayout(this);
        cameraBox.addView(preview, new android.widget.FrameLayout.LayoutParams(-1, -1));
        cameraBox.addView(overlay, new android.widget.FrameLayout.LayoutParams(-1, -1));
        root.addView(cameraBox, new LinearLayout.LayoutParams(-1, 0, 1));

        status = new TextView(this);
        status.setTextColor(Color.WHITE); status.setText("Native camera · " + serial + " · face tracking ready");
        status.setGravity(Gravity.CENTER); status.setPadding(8, 8, 8, 8);
        root.addView(status, new LinearLayout.LayoutParams(-1, 42));

        HorizontalScrollView filterScroll = new HorizontalScrollView(this);
        LinearLayout controls = new LinearLayout(this);
        controls.setGravity(Gravity.CENTER_VERTICAL); controls.setPadding(8, 8, 8, 12);
        String[] names = {"Off", "Long hair", "Beard", "Cute face", "Glasses", "Freckles", "Blush", "Cartoon"};
        for (String name : names) {
            TextView b = button(name);
            controls.addView(b, new LinearLayout.LayoutParams(112, 52));
        }
        filterScroll.addView(controls);
        root.addView(filterScroll, new LinearLayout.LayoutParams(-1, 68));

        LinearLayout captureControls = new LinearLayout(this);
        captureControls.setGravity(Gravity.CENTER); captureControls.setPadding(8, 0, 8, 12);
        TextView capture = button("Capture");
        capture.setOnClickListener(v -> captureFilteredFrame());
        captureControls.addView(capture, new LinearLayout.LayoutParams(0, 52, 1));
        TextView video = button("Record video");
        video.setOnClickListener(v -> toggleVideo(video));
        captureControls.addView(video, new LinearLayout.LayoutParams(0, 52, 1));
        root.addView(captureControls);
        setContentView(root);
    }

    private TextView button(String text) {
        TextView b = new TextView(this);
        b.setText(text); b.setTextColor(Color.WHITE); b.setGravity(Gravity.CENTER);
        b.setTextSize(11); b.setOnClickListener(v -> {
            filter = text;
            getPreferences(MODE_PRIVATE).edit().putString("filter:" + serial, filter).apply();
            overlay.invalidate();
            status.setText("Filter: " + filter + " · Face tracking stays on-device");
        });
        return b;
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                ProcessCameraProvider provider = future.get();
                Preview cameraPreview = new Preview.Builder().build();
                cameraPreview.setSurfaceProvider(preview.getSurfaceProvider());
                ImageAnalysis analysis = new ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                Recorder recorder = new Recorder.Builder()
                        .setQualitySelector(QualitySelector.from(Quality.HD))
                        .build();
                VideoCapture<Recorder> videoCapture = VideoCapture.withOutput(recorder);
                analysis.setAnalyzer(cameraExecutor, image -> {
                    InputImage input = InputImage.fromMediaImage(image.getImage(),
                            image.getImageInfo().getRotationDegrees());
                    detector.process(input).addOnSuccessListener(faces -> runOnUiThread(() -> {
                        overlay.setFaces(faces);
                        status.setText(faces.isEmpty()
                                ? "Filter: " + filter + " · Show a face to the camera"
                                : "Filter: " + filter + " · Face tracked");
                    })).addOnCompleteListener(done -> image.close());
                });
                provider.unbindAll();
                preview.setTag(videoCapture);
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_FRONT_CAMERA, cameraPreview, analysis, videoCapture);
            } catch (Exception e) { status.setText("Camera unavailable: " + e.getMessage()); }
        }, ContextCompat.getMainExecutor(this));
    }

    private void toggleVideo(TextView button) {
        if (recording != null) {
            recording.stop();
            recording = null;
            button.setText("Record video");
            status.setText("Video saved to DCIM/AuraFilters · Filter: " + filter);
            return;
        }
        Object tag = preview.getTag();
        if (!(tag instanceof VideoCapture)) {
            Toast.makeText(this, "Video camera is not ready", Toast.LENGTH_SHORT).show();
            return;
        }
        ContentValues values = new ContentValues();
        values.put(MediaStore.Video.Media.DISPLAY_NAME, "AuraFilter_" + System.currentTimeMillis() + ".mp4");
        values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
        values.put(MediaStore.Video.Media.RELATIVE_PATH, "DCIM/AuraFilters");
        MediaStoreOutputOptions output = new MediaStoreOutputOptions.Builder(
                getContentResolver(), MediaStore.Video.Media.EXTERNAL_CONTENT_URI)
                .setContentValues(values).build();
        VideoCapture<?> capture = (VideoCapture<?>) tag;
        androidx.camera.video.PendingRecording pending =
                ((VideoCapture<Recorder>) capture).getOutput().prepareRecording(this, output);
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED) {
            pending = pending.withAudioEnabled();
        }
        recording = pending.start(ContextCompat.getMainExecutor(this), event -> {
            if (event instanceof VideoRecordEvent.Finalize) {
                VideoRecordEvent.Finalize done = (VideoRecordEvent.Finalize) event;
                recording = null;
                button.setText("Record video");
                status.setText(done.hasError()
                        ? "Video could not be saved"
                        : "Video saved to DCIM/AuraFilters");
            }
        });
        button.setText("Stop video");
        status.setText("Recording locally · Filter: " + filter);
    }

    private void captureFilteredFrame() {
        Bitmap source = preview.getBitmap();
        if (source == null) { Toast.makeText(this, "Camera preview is not ready", Toast.LENGTH_SHORT).show(); return; }
        Bitmap result = source.copy(Bitmap.Config.ARGB_8888, true);
        Canvas canvas = new Canvas(result);
        overlay.drawFilter(canvas, result.getWidth(), result.getHeight());
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, "AuraFilter_" + System.currentTimeMillis() + ".jpg");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, "DCIM/AuraFilters");
        Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        try (OutputStream out = uri == null ? null : getContentResolver().openOutputStream(uri)) {
            if (out == null || !result.compress(Bitmap.CompressFormat.JPEG, 95, out)) throw new Exception("save failed");
            Toast.makeText(this, "Filtered photo saved to DCIM/AuraFilters", Toast.LENGTH_SHORT).show();
        } catch (Exception e) { if (uri != null) getContentResolver().delete(uri, null, null); Toast.makeText(this, e.getMessage(), Toast.LENGTH_SHORT).show(); }
    }

    @Override protected void onDestroy() {
        if (recording != null) { recording.stop(); recording = null; }
        super.onDestroy(); if (cameraExecutor != null) cameraExecutor.shutdown(); if (detector != null) detector.close();
    }

    @Override protected void onStop() {
        super.onStop();
        if (recording == null && status != null) status.setText("Camera paused · return to resume preview");
    }

    @Override public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != CAMERA_REQUEST) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        } else {
            status.setText("Camera permission is required. Allow camera access in Android Settings.");
        }
    }

    private final class FilterOverlay extends View {
        private List<Face> faces = Collections.emptyList();
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        FilterOverlay(android.content.Context context) { super(context); paint.setStrokeWidth(6); setWillNotDraw(false); }
        void setFaces(List<Face> value) { faces = value == null ? Collections.emptyList() : value; invalidate(); }
        @Override protected void onDraw(Canvas canvas) { super.onDraw(canvas); drawFilter(canvas, getWidth(), getHeight()); }
        void drawFilter(Canvas canvas, int width, int height) {
            if ("Off".equals(filter)) return;
            paint.setStyle(Paint.Style.STROKE); paint.setColor(Color.WHITE);
            for (Face face : faces) {
                Rect r = face.getBoundingBox();
                float sx = width / (float) Math.max(1, preview.getWidth());
                float sy = height / (float) Math.max(1, preview.getHeight());
                float left = width - r.right * sx, right = width - r.left * sx;
                float top = r.top * sy, bottom = r.bottom * sy;
                float cx = (left + right) / 2f, cy = (top + bottom) / 2f;
                float w = right - left;
                if ("Glasses".equals(filter)) { canvas.drawOval(left + w*.05f, cy-w*.12f, cx-w*.04f, cy+w*.03f, paint); canvas.drawOval(cx+w*.04f, cy-w*.12f, right-w*.05f, cy+w*.03f, paint); canvas.drawLine(cx-w*.05f, cy-w*.04f, cx+w*.05f, cy-w*.04f, paint); }
                if ("Beard".equals(filter)) { paint.setStyle(Paint.Style.FILL); paint.setColor(0xAA3B2418); canvas.drawOval(left+w*.25f, cy+w*.12f, right-w*.25f, bottom-w*.03f, paint); }
                if ("Long hair".equals(filter)) { paint.setStyle(Paint.Style.FILL); paint.setColor(0xDD4A2B22); canvas.drawOval(left-w*.12f, top-w*.12f, right+w*.12f, bottom+w*.18f, paint); paint.setColor(Color.TRANSPARENT); paint.setXfermode(new android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.CLEAR)); canvas.drawOval(left+w*.08f, top+w*.04f, right-w*.08f, bottom-w*.04f, paint); paint.setXfermode(null); paint.setColor(0xDD4A2B22); canvas.drawRect(left-w*.1f, top+w*.18f, left+w*.08f, bottom+w*.18f, paint); canvas.drawRect(right-w*.08f, top+w*.18f, right+w*.1f, bottom+w*.18f, paint); }
                if ("Cute face".equals(filter)) { paint.setStyle(Paint.Style.FILL); paint.setColor(0xAAFF80AB); canvas.drawCircle(left+w*.25f, cy+w*.08f, w*.1f, paint); canvas.drawCircle(right-w*.25f, cy+w*.08f, w*.1f, paint); paint.setColor(Color.WHITE); canvas.drawCircle(left+w*.34f, cy-w*.04f, w*.07f, paint); canvas.drawCircle(right-w*.34f, cy-w*.04f, w*.07f, paint); paint.setColor(0xFF334155); canvas.drawCircle(left+w*.34f, cy-w*.04f, w*.035f, paint); canvas.drawCircle(right-w*.34f, cy-w*.04f, w*.035f, paint); }
                if ("Blush".equals(filter)) { paint.setColor(0x88FF5C87); canvas.drawCircle(left+w*.18f, cy+w*.08f, w*.09f, paint); canvas.drawCircle(right-w*.18f, cy+w*.08f, w*.09f, paint); }
                if ("Freckles".equals(filter)) { paint.setColor(0xFFFFB07C); for (int i=0;i<8;i++) canvas.drawCircle(left+w*(.25f+(i%4)*.16f), cy+w*(.04f+(i/4)*.08f), 4, paint); }
                if ("Cartoon".equals(filter)) { paint.setStyle(Paint.Style.STROKE); paint.setColor(Color.YELLOW); paint.setStrokeWidth(10); canvas.drawOval(left-w*.05f, top-w*.05f, right+w*.05f, bottom+w*.05f, paint); }
            }
        }
    }
}
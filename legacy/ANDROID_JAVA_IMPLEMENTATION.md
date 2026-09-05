# Android Java Implementation Guide for RFID Attendance System

This guide explains how to implement the RFID attendance system in Android Java based on the Node.js implementation in `main.js`.

## Overview

The system connects to RFID reader devices via TCP, processes RFID data, stores attendance records locally in SQLite, and synchronizes data with a remote server.

## Key Features

1. **TCP Socket Connection** to RFID reader devices
2. **Hex Data Processing** to extract RFID codes
3. **SQLite Database** for local attendance storage
4. **Attendance Caching** for performance optimization
5. **Server Synchronization** via HTTP API
6. **Multi-device Support** (multiple RFID readers)

---

## 1. Required Dependencies

Add these dependencies to your `build.gradle` file:

```gradle
dependencies {
    // For HTTP requests
    implementation 'com.squareup.okhttp3:okhttp:4.10.0'
    
    // For JSON handling
    implementation 'com.google.code.gson:gson:2.10.1'
    
    // For database (Android built-in SQLite)
    // No external dependency needed
}
```

Add these permissions to your `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

---

## 2. Database Implementation

### DatabaseHelper.java

```java
import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

public class DatabaseHelper extends SQLiteOpenHelper {
    private static final String DATABASE_NAME = "attendance.db";
    private static final int DATABASE_VERSION = 1;
    
    public static final String TABLE_ATTENDANCE = "attendance";
    public static final String COLUMN_ID = "id";
    public static final String COLUMN_DATE = "date";
    public static final String COLUMN_RFID = "rfid";
    public static final String COLUMN_INTIME = "intime";
    public static final String COLUMN_OUTTIME = "outtime";
    public static final String COLUMN_IS_SYNCED = "isSynced";
    
    private static final String CREATE_TABLE = 
        "CREATE TABLE IF NOT EXISTS " + TABLE_ATTENDANCE + " (" +
        COLUMN_ID + " INTEGER PRIMARY KEY AUTOINCREMENT, " +
        COLUMN_DATE + " TEXT NOT NULL, " +
        COLUMN_RFID + " TEXT NOT NULL CHECK (length(" + COLUMN_RFID + ") = 24), " +
        COLUMN_INTIME + " TEXT NOT NULL, " +
        COLUMN_OUTTIME + " TEXT, " +
        COLUMN_IS_SYNCED + " INTEGER DEFAULT 0, " +
        "UNIQUE(" + COLUMN_DATE + ", " + COLUMN_RFID + "))";
    
    public DatabaseHelper(Context context) {
        super(context, DATABASE_NAME, null, DATABASE_VERSION);
    }
    
    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(CREATE_TABLE);
        // Enable WAL mode for better write concurrency
        db.execSQL("PRAGMA journal_mode = WAL;");
    }
    
    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        db.execSQL("DROP TABLE IF EXISTS " + TABLE_ATTENDANCE);
        onCreate(db);
    }
}
```

---

## 3. Attendance Model

### AttendanceRecord.java

```java
public class AttendanceRecord {
    private int id;
    private String date;
    private String rfid;
    private String intime;
    private String outtime;
    private int isSynced;
    
    public AttendanceRecord() {}
    
    public AttendanceRecord(String date, String rfid, String intime, String outtime) {
        this.date = date;
        this.rfid = rfid;
        this.intime = intime;
        this.outtime = outtime;
        this.isSynced = 0;
    }
    
    // Getters and Setters
    public int getId() { return id; }
    public void setId(int id) { this.id = id; }
    
    public String getDate() { return date; }
    public void setDate(String date) { this.date = date; }
    
    public String getRfid() { return rfid; }
    public void setRfid(String rfid) { this.rfid = rfid; }
    
    public String getIntime() { return intime; }
    public void setIntime(String intime) { this.intime = intime; }
    
    public String getOuttime() { return outtime; }
    public void setOuttime(String outtime) { this.outtime = outtime; }
    
    public int getIsSynced() { return isSynced; }
    public void setIsSynced(int isSynced) { this.isSynced = isSynced; }
}
```

---

## 4. Attendance Repository

### AttendanceRepository.java

```java
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class AttendanceRepository {
    private DatabaseHelper dbHelper;
    private Map<String, AttendanceRecord> attendanceCache;
    
    public AttendanceRepository(Context context) {
        dbHelper = new DatabaseHelper(context);
        attendanceCache = new HashMap<>();
    }
    
    // Load today's attendance records into cache
    public void loadAttendanceCache(String today) {
        attendanceCache.clear();
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        
        String query = "SELECT * FROM " + DatabaseHelper.TABLE_ATTENDANCE + 
                      " WHERE " + DatabaseHelper.COLUMN_DATE + " = ?";
        
        Cursor cursor = db.rawQuery(query, new String[]{today});
        
        if (cursor.moveToFirst()) {
            do {
                AttendanceRecord record = new AttendanceRecord();
                record.setId(cursor.getInt(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_ID)));
                record.setDate(cursor.getString(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_DATE)));
                record.setRfid(cursor.getString(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_RFID)));
                record.setIntime(cursor.getString(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_INTIME)));
                record.setOuttime(cursor.getString(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_OUTTIME)));
                record.setIsSynced(cursor.getInt(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_IS_SYNCED)));
                
                attendanceCache.put(record.getRfid(), record);
            } while (cursor.moveToNext());
        }
        
        cursor.close();
    }
    
    // Insert or update attendance record
    public void insertOrUpdate(String rfid, String date, String time, int deviceUpdateTime) {
        if (attendanceCache.containsKey(rfid)) {
            AttendanceRecord record = attendanceCache.get(rfid);
            
            // Check if date changed (new day)
            if (!record.getDate().equals(date)) {
                attendanceCache.clear();
                // Create new record for new day
                insertNewRecord(rfid, date, time);
            } else {
                // Update outtime if enough time has passed
                long lastOutTime = parseTime(record.getDate() + " " + record.getOuttime());
                long currentTime = parseTime(date + " " + time);
                long timeDiff = (currentTime - lastOutTime) / 1000; // in seconds
                
                if (timeDiff > deviceUpdateTime) {
                    record.setOuttime(time);
                    record.setIsSynced(0);
                    attendanceCache.put(rfid, record);
                }
            }
        } else {
            // New record
            insertNewRecord(rfid, date, time);
        }
    }
    
    private void insertNewRecord(String rfid, String date, String time) {
        AttendanceRecord record = new AttendanceRecord(date, rfid, time, time);
        attendanceCache.put(rfid, record);
    }
    
    // Flush cache to database
    public void flushCache() {
        if (attendanceCache.isEmpty()) return;
        
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        
        try {
            for (AttendanceRecord record : attendanceCache.values()) {
                ContentValues values = new ContentValues();
                values.put(DatabaseHelper.COLUMN_DATE, record.getDate());
                values.put(DatabaseHelper.COLUMN_RFID, record.getRfid());
                values.put(DatabaseHelper.COLUMN_INTIME, record.getIntime());
                values.put(DatabaseHelper.COLUMN_OUTTIME, record.getOuttime());
                values.put(DatabaseHelper.COLUMN_IS_SYNCED, record.getIsSynced());
                
                // Insert or replace
                long result = db.insertWithOnConflict(
                    DatabaseHelper.TABLE_ATTENDANCE,
                    null,
                    values,
                    SQLiteDatabase.CONFLICT_REPLACE
                );
            }
            
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }
    
    // Get unsynced records
    public List<AttendanceRecord> getUnsyncedRecords() {
        List<AttendanceRecord> records = new ArrayList<>();
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        
        String query = "SELECT * FROM " + DatabaseHelper.TABLE_ATTENDANCE + 
                      " WHERE " + DatabaseHelper.COLUMN_IS_SYNCED + " = 0";
        
        Cursor cursor = db.rawQuery(query, null);
        
        if (cursor.moveToFirst()) {
            do {
                AttendanceRecord record = new AttendanceRecord();
                record.setId(cursor.getInt(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_ID)));
                record.setDate(cursor.getString(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_DATE)));
                record.setRfid(cursor.getString(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_RFID)));
                record.setIntime(cursor.getString(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_INTIME)));
                record.setOuttime(cursor.getString(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_OUTTIME)));
                record.setIsSynced(cursor.getInt(cursor.getColumnIndexOrThrow(DatabaseHelper.COLUMN_IS_SYNCED)));
                
                records.add(record);
            } while (cursor.moveToNext());
        }
        
        cursor.close();
        return records;
    }
    
    // Mark records as synced
    public void markAsSynced(List<Integer> ids) {
        if (ids.isEmpty()) return;
        
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        
        StringBuilder whereClause = new StringBuilder(DatabaseHelper.COLUMN_ID + " IN (");
        for (int i = 0; i < ids.size(); i++) {
            whereClause.append(ids.get(i));
            if (i < ids.size() - 1) whereClause.append(",");
        }
        whereClause.append(")");
        
        ContentValues values = new ContentValues();
        values.put(DatabaseHelper.COLUMN_IS_SYNCED, 1);
        
        db.update(DatabaseHelper.TABLE_ATTENDANCE, values, whereClause.toString(), null);
    }
    
    private long parseTime(String dateTime) {
        try {
            java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
            return sdf.parse(dateTime).getTime();
        } catch (Exception e) {
            return 0;
        }
    }
}
```

---

## 5. TCP Socket Client

### RFIDSocketClient.java

```java
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class RFIDSocketClient extends Thread {
    private static final String TAG = "RFIDSocketClient";
    
    private String serverHost;
    private int serverPort;
    private Socket socket;
    private InputStream inputStream;
    private OutputStream outputStream;
    private boolean isRunning = false;
    private RFIDDataListener listener;
    private Handler reconnectHandler;
    private int reconnectDelay = 5000; // 5 seconds
    
    public interface RFIDDataListener {
        void onRFIDReceived(String rfid, String date, String time);
        void onConnectionStatusChanged(boolean connected, String host);
    }
    
    public RFIDSocketClient(String host, int port, RFIDDataListener listener) {
        this.serverHost = host;
        this.serverPort = port;
        this.listener = listener;
        this.reconnectHandler = new Handler(Looper.getMainLooper());
    }
    
    @Override
    public void run() {
        isRunning = true;
        connectToServer();
    }
    
    private void connectToServer() {
        while (isRunning) {
            try {
                Log.d(TAG, "Connecting to " + serverHost + ":" + serverPort);
                
                socket = new Socket(serverHost, serverPort);
                socket.setKeepAlive(true);
                socket.setSoTimeout(60000); // 60 second timeout
                
                inputStream = socket.getInputStream();
                outputStream = socket.getOutputStream();
                
                // Send init command
                byte[] initCommand = buildInitCommand();
                outputStream.write(initCommand);
                outputStream.flush();
                
                Log.d(TAG, "Connected to " + serverHost);
                notifyConnectionStatus(true);
                
                // Read data loop
                byte[] buffer = new byte[1024];
                int bytesRead;
                
                while (isRunning && (bytesRead = inputStream.read(buffer)) != -1) {
                    processReceivedData(buffer, bytesRead);
                }
                
            } catch (IOException e) {
                Log.e(TAG, "Connection error: " + e.getMessage());
                notifyConnectionStatus(false);
            } finally {
                closeConnection();
                
                if (isRunning) {
                    Log.d(TAG, "Reconnecting in " + (reconnectDelay / 1000) + " seconds...");
                    try {
                        Thread.sleep(reconnectDelay);
                    } catch (InterruptedException e) {
                        e.printStackTrace();
                    }
                }
            }
        }
    }
    
    private byte[] buildInitCommand() {
        // Build init command: cfff00720017a5
        String hexString = "cfff00720017a5";
        return hexStringToByteArray(hexString);
    }
    
    private void processReceivedData(byte[] data, int length) {
        // Convert to hex string
        String hexMessage = bytesToHex(data, length);
        
        // Extract RFID: remove last 4 hex digits, take last 24 characters
        if (hexMessage.length() >= 28) {
            String processedHex = hexMessage.substring(0, hexMessage.length() - 4);
            if (processedHex.length() >= 24) {
                String rfid = processedHex.substring(processedHex.length() - 24);
                
                // Get current date and time
                SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd", Locale.getDefault());
                SimpleDateFormat timeFormat = new SimpleDateFormat("HH:mm:ss", Locale.getDefault());
                Date now = new Date();
                
                String currentDate = dateFormat.format(now);
                String currentTime = timeFormat.format(now);
                
                Log.d(TAG, "RFID received from " + serverHost + ": " + rfid);
                
                if (listener != null) {
                    listener.onRFIDReceived(rfid, currentDate, currentTime);
                }
            }
        }
    }
    
    private void notifyConnectionStatus(boolean connected) {
        if (listener != null) {
            reconnectHandler.post(() -> 
                listener.onConnectionStatusChanged(connected, serverHost)
            );
        }
    }
    
    public void stopClient() {
        isRunning = false;
        closeConnection();
        interrupt();
    }
    
    private void closeConnection() {
        try {
            if (inputStream != null) inputStream.close();
            if (outputStream != null) outputStream.close();
            if (socket != null && !socket.isClosed()) socket.close();
        } catch (IOException e) {
            Log.e(TAG, "Error closing connection: " + e.getMessage());
        }
    }
    
    // Utility: Convert bytes to hex string
    private String bytesToHex(byte[] bytes, int length) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < length; i++) {
            sb.append(String.format("%02x", bytes[i]));
        }
        return sb.toString();
    }
    
    // Utility: Convert hex string to byte array
    private byte[] hexStringToByteArray(String hex) {
        int len = hex.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            data[i / 2] = (byte) ((Character.digit(hex.charAt(i), 16) << 4)
                    + Character.digit(hex.charAt(i + 1), 16));
        }
        return data;
    }
}
```

---

## 6. Server Sync Service

### ServerSyncService.java

```java
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class ServerSyncService {
    private static final String TAG = "ServerSyncService";
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    
    private String mainDomain;
    private String mainProtocol;
    private String localToken;
    private String deviceId;
    private OkHttpClient httpClient;
    private AttendanceRepository repository;
    private boolean isSyncing = false;
    
    public ServerSyncService(String protocol, String domain, String token, String deviceId, 
                            AttendanceRepository repository) {
        this.mainProtocol = protocol;
        this.mainDomain = domain;
        this.localToken = token;
        this.deviceId = deviceId;
        this.repository = repository;
        
        this.httpClient = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build();
    }
    
    public void syncDataWithServer() {
        if (isSyncing) {
            Log.d(TAG, "Sync already in progress");
            return;
        }
        
        isSyncing = true;
        
        new Thread(() -> {
            try {
                // Get unsynced records
                List<AttendanceRecord> unsyncedRecords = repository.getUnsyncedRecords();
                
                if (unsyncedRecords.isEmpty()) {
                    Log.d(TAG, "No data to sync");
                    return;
                }
                
                // Build JSON payload
                JSONObject payload = new JSONObject();
                payload.put("token", localToken);
                payload.put("device_id", deviceId);
                
                JSONArray datasArray = new JSONArray();
                for (AttendanceRecord record : unsyncedRecords) {
                    JSONObject dataObj = new JSONObject();
                    dataObj.put("rfid", record.getRfid());
                    dataObj.put("in_time", record.getIntime());
                    dataObj.put("out_time", record.getOuttime());
                    dataObj.put("date", record.getDate());
                    datasArray.put(dataObj);
                }
                payload.put("datas", datasArray);
                
                // Make HTTP request
                String url = mainProtocol + "://" + mainDomain + "/api/device/set";
                RequestBody body = RequestBody.create(payload.toString(), JSON);
                Request request = new Request.Builder()
                    .url(url)
                    .post(body)
                    .build();
                
                Log.d(TAG, "Syncing " + unsyncedRecords.size() + " records to server");
                
                Response response = httpClient.newCall(request).execute();
                
                if (response.isSuccessful()) {
                    // Mark records as synced
                    List<Integer> ids = new ArrayList<>();
                    for (AttendanceRecord record : unsyncedRecords) {
                        ids.add(record.getId());
                    }
                    repository.markAsSynced(ids);
                    
                    Log.d(TAG, "Sync successful: " + response.body().string());
                } else {
                    Log.e(TAG, "Sync failed: " + response.code() + " " + response.message());
                }
                
                response.close();
                
            } catch (Exception e) {
                Log.e(TAG, "Error syncing data: " + e.getMessage());
            } finally {
                isSyncing = false;
            }
        }).start();
    }
}
```

---

## 7. Main Service Implementation

### AttendanceService.java

```java
import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;

public class AttendanceService extends Service implements RFIDSocketClient.RFIDDataListener {
    private static final String TAG = "AttendanceService";
    
    private AttendanceRepository repository;
    private ServerSyncService syncService;
    private List<RFIDSocketClient> socketClients;
    private Handler handler;
    
    // Configuration
    private String[] serverHosts = {"192.168.1.100", "192.168.1.101"}; // Your RFID reader IPs
    private int serverPort = 5000;
    private String mainDomain = "yourdomain.com";
    private String mainProtocol = "https";
    private String localToken = "your_local_token";
    private String deviceId = "your_device_id";
    private int deviceUpdateTime = 30; // seconds
    
    @Override
    public void onCreate() {
        super.onCreate();
        
        repository = new AttendanceRepository(this);
        syncService = new ServerSyncService(mainProtocol, mainDomain, localToken, deviceId, repository);
        socketClients = new ArrayList<>();
        handler = new Handler();
        
        // Load today's cache
        String today = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.getDefault())
            .format(new java.util.Date());
        repository.loadAttendanceCache(today);
        
        // Start socket clients for each RFID reader
        for (String host : serverHosts) {
            RFIDSocketClient client = new RFIDSocketClient(host.trim(), serverPort, this);
            client.start();
            socketClients.add(client);
        }
        
        // Start periodic tasks
        startPeriodicFlush();
        startPeriodicSync();
        
        Log.d(TAG, "AttendanceService started");
    }
    
    @Override
    public void onRFIDReceived(String rfid, String date, String time) {
        Log.d(TAG, "RFID: " + rfid + ", Date: " + date + ", Time: " + time);
        repository.insertOrUpdate(rfid, date, time, deviceUpdateTime);
    }
    
    @Override
    public void onConnectionStatusChanged(boolean connected, String host) {
        String status = connected ? "Connected" : "Disconnected";
        Log.d(TAG, host + " - " + status);
        // You can update UI or notification here
    }
    
    private void startPeriodicFlush() {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                repository.flushCache();
                handler.postDelayed(this, 1000); // Flush every 1 second
            }
        }, 1000);
    }
    
    private void startPeriodicSync() {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                syncService.syncDataWithServer();
                handler.postDelayed(this, 30000); // Sync every 30 seconds
            }
        }, 30000);
    }
    
    @Override
    public void onDestroy() {
        super.onDestroy();
        
        // Stop all socket clients
        for (RFIDSocketClient client : socketClients) {
            client.stopClient();
        }
        
        // Flush cache one last time
        repository.flushCache();
        
        handler.removeCallbacksAndMessages(null);
        
        Log.d(TAG, "AttendanceService stopped");
    }
    
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
```

---

## 8. MainActivity Example

### MainActivity.java

```java
import android.content.Intent;
import android.os.Bundle;
import android.widget.Button;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {
    
    private TextView statusText;
    private Button startButton;
    private Button stopButton;
    
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        
        statusText = findViewById(R.id.statusText);
        startButton = findViewById(R.id.startButton);
        stopButton = findViewById(R.id.stopButton);
        
        startButton.setOnClickListener(v -> {
            Intent serviceIntent = new Intent(this, AttendanceService.class);
            startService(serviceIntent);
            statusText.setText("Service Started");
        });
        
        stopButton.setOnClickListener(v -> {
            Intent serviceIntent = new Intent(this, AttendanceService.class);
            stopService(serviceIntent);
            statusText.setText("Service Stopped");
        });
    }
}
```

---

## 9. Configuration

Create a configuration class or use SharedPreferences to store:

### Config.java

```java
public class Config {
    // Server Configuration
    public static final String[] RFID_READER_HOSTS = {"192.168.1.100", "192.168.1.101"};
    public static final int RFID_READER_PORT = 5000;
    
    // Remote Server Configuration
    public static final String MAIN_DOMAIN = "yourdomain.com";
    public static final String MAIN_PROTOCOL = "https";
    public static final String LOCAL_TOKEN = "your_local_token";
    public static final String DEVICE_ID = "your_device_id";
    
    // Timing Configuration
    public static final int DEVICE_UPDATE_TIME = 30; // seconds
    public static final int FLUSH_INTERVAL = 1000; // milliseconds
    public static final int SYNC_INTERVAL = 30000; // milliseconds
}
```

---

## 10. Key Differences from Node.js

1. **Threading**: Android requires background tasks to run on separate threads (not UI thread)
2. **Database**: Use Android's SQLiteOpenHelper instead of node-sqlite3
3. **HTTP Client**: Use OkHttp instead of axios
4. **Socket**: Use Java's Socket class instead of Node's net module
5. **Service**: Use Android Service for background operations
6. **Lifecycle**: Handle Android lifecycle events (onCreate, onDestroy)

---

## 11. Testing

1. **Test TCP Connection**: Verify connection to RFID reader devices
2. **Test RFID Processing**: Check hex to RFID conversion
3. **Test Database**: Verify insert/update operations
4. **Test Sync**: Confirm data syncs to remote server
5. **Test Reconnection**: Ensure reconnection after network loss

---

## 12. Important Notes

- Run the AttendanceService as a foreground service for Android 8.0+ to prevent it from being killed
- Handle permissions properly (INTERNET, etc.)
- Consider using WorkManager for reliable background sync
- Implement proper error handling and logging
- Use WakeLock if needed to keep device awake for RFID scanning
- Consider adding notification to show service status

---

## 13. Next Steps

1. Adjust configuration values (IP addresses, tokens, etc.)
2. Test with actual RFID reader hardware
3. Implement UI for monitoring attendance records
4. Add proper notification system
5. Implement proper error handling and retry logic
6. Consider adding offline mode indicators

---

## Support

For issues or questions, refer to:
- Original Node.js implementation: `main.js`
- Android documentation: https://developer.android.com
- OkHttp documentation: https://square.github.io/okhttp/

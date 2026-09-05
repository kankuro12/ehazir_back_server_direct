# Android Kotlin Implementation Plan — ZKTeco HTTP ADMS Attendance Server

This document is a step-by-step plan to port `attendence.js` into a fully functional Android Kotlin application. The Node.js file runs an HTTP server that ZKTeco biometric devices push attendance punches to. The Android app will replicate this server on-device using an embedded HTTP server, persist data in Room, and optionally sync to a remote backend.

---

## Architecture Overview

```
ZKTeco Device
     │  HTTP POST (ADMS protocol)
     ▼
Android App (Embedded HTTP Server — NanoHTTPD)
     │
     ├── /iclock/getrequest   → respond "OK"
     ├── /iclock/registry     → respond "OK"
     └── /iclock/cdata        → parse punch records → AttendanceCache
                                                            │
                                                   (flush every 1 s)
                                                            │
                                                      Room Database
                                                            │
                                                   (background sync)
                                                            │
                                                    Remote REST API
```

---

## Phase 1 — Project Setup

### 1.1 Gradle Dependencies

Add to `app/build.gradle.kts` (or `build.gradle`):

```kotlin
dependencies {
    // Embedded HTTP server
    implementation("org.nanohttpd:nanohttpd:2.3.1")

    // Room (local SQLite)
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    kapt("androidx.room:room-compiler:2.6.1")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // ViewModel + LiveData
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-livedata-ktx:2.7.0")

    // Retrofit (remote sync)
    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.squareup.retrofit2:converter-gson:2.9.0")

    // WorkManager (background sync)
    implementation("androidx.work:work-runtime-ktx:2.9.0")
}
```

### 1.2 AndroidManifest.xml Permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />

<!-- Declare the foreground service -->
<service
    android:name=".service.AttendanceServerService"
    android:foregroundServiceType="dataSync"
    android:exported="false" />

<!-- Auto-start on boot -->
<receiver
    android:name=".receiver.BootReceiver"
    android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
    </intent-filter>
</receiver>
```

---

## Phase 2 — Data Layer (Room Database)

Mirrors the SQLite schema in `attendence.js`:

```sql
CREATE TABLE attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  rfid TEXT NOT NULL CHECK (length(rfid) = 24),
  intime TEXT NOT NULL,
  outtime TEXT,
  isSynced INTEGER DEFAULT 0,
  UNIQUE(date, rfid)
)
```

### 2.1 Entity — `AttendanceEntity.kt`

```kotlin
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "attendance",
    indices = [Index(value = ["date", "rfid"], unique = true)]
)
data class AttendanceEntity(
    @PrimaryKey(autoGenerate = true) val id: Int = 0,
    val date: String,
    val rfid: String,          // 24-character, left-padded with zeros
    val intime: String,
    val outtime: String?,
    val isSynced: Int = 0
)
```

### 2.2 DAO — `AttendanceDao.kt`

```kotlin
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface AttendanceDao {

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIfNotExists(record: AttendanceEntity): Long

    @Query("""
        UPDATE attendance
        SET outtime = :outtime, isSynced = 0
        WHERE date = :date AND rfid = :rfid
    """)
    suspend fun updateOuttime(rfid: String, date: String, outtime: String)

    @Query("SELECT * FROM attendance WHERE isSynced = 0")
    suspend fun getUnsyncedRecords(): List<AttendanceEntity>

    @Query("UPDATE attendance SET isSynced = 1 WHERE id IN (:ids)")
    suspend fun markAsSynced(ids: List<Int>)

    @Query("SELECT * FROM attendance WHERE date = :date")
    suspend fun getByDate(date: String): List<AttendanceEntity>
}
```

### 2.3 Database — `AttendanceDatabase.kt`

```kotlin
import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [AttendanceEntity::class], version = 1, exportSchema = false)
abstract class AttendanceDatabase : RoomDatabase() {
    abstract fun attendanceDao(): AttendanceDao

    companion object {
        @Volatile private var INSTANCE: AttendanceDatabase? = null

        fun getInstance(context: Context): AttendanceDatabase =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    AttendanceDatabase::class.java,
                    "attendance1.db"
                )
                .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING) // WAL mode like attendence.js
                .build()
                .also { INSTANCE = it }
            }
    }
}
```

---

## Phase 3 — Attendance Cache

Mirrors the `attendanceCache` Map and `saveAttendanceRecord()` / `flushCache()` logic in `attendence.js`.

### 3.1 Cache Model — `CachedRecord.kt`

```kotlin
data class CachedRecord(
    val date: String,
    val intime: String,
    var outtime: String,
    var isNew: Boolean = true,
    var updated: Boolean = false
)
```

### 3.2 Cache Manager — `AttendanceCacheManager.kt`

```kotlin
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

class AttendanceCacheManager(
    private val deviceUpdateTimeSec: Int = 30   // mirrors DEVICE_UPDATE_TIME = 30
) {
    private val cache = ConcurrentHashMap<String, CachedRecord>()
    private val sdf = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())

    /**
     * Process a single punch event.
     * Mirrors saveAttendanceRecord() in attendence.js.
     */
    fun processPunch(userId: String, punchDateTime: String) {
        val parts = punchDateTime.split(" ")
        if (parts.size < 2) return
        val currentDate = parts[0]
        val currentTime = parts[1]

        // Pad userId to 24 characters (mirrors userId.padStart(24, '0'))
        val rfid = userId.padStart(24, '0')

        val cached = cache[rfid]
        if (cached != null) {
            if (cached.date != currentDate) {
                // New day — clear cache
                cache.clear()
            } else {
                val lastOut = sdf.parse("${cached.date} ${cached.outtime}")?.time ?: 0L
                val current = sdf.parse(punchDateTime)?.time ?: 0L
                val diffSec = (current - lastOut) / 1000

                if (diffSec > deviceUpdateTimeSec) {
                    cached.outtime = currentTime
                    cached.updated = true
                }
                return
            }
        }

        // New entry
        cache[rfid] = CachedRecord(
            date = currentDate,
            intime = currentTime,
            outtime = currentTime,
            isNew = true,
            updated = false
        )
    }

    /**
     * Drain the cache and return records ready for DB write.
     * Mirrors flushCache() in attendence.js.
     */
    fun drainForFlush(): List<Pair<String, CachedRecord>> {
        val toFlush = cache.entries
            .filter { it.value.isNew || it.value.updated }
            .map { it.key to it.value }

        toFlush.forEach { (_, record) ->
            record.isNew = false
            record.updated = false
        }

        return toFlush
    }

    fun size() = cache.size
}
```

---

## Phase 4 — Embedded HTTP Server (NanoHTTPD)

Mirrors the three Express routes in `attendence.js`:
- `GET/POST /iclock/getrequest`
- `GET/POST /iclock/registry`
- `POST /iclock/cdata`

### 4.1 ADMS Server — `ZKTecoAdmsServer.kt`

```kotlin
import fi.iki.elonen.NanoHTTPD
import android.util.Log

class ZKTecoAdmsServer(
    port: Int = 3000,
    private val cacheManager: AttendanceCacheManager
) : NanoHTTPD(port) {

    companion object {
        private const val TAG = "ZKTecoAdmsServer"
    }

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        Log.d(TAG, "📡 ${session.method} $uri params=${session.parameters}")

        return when {
            uri.startsWith("/iclock/getrequest") -> handleGetRequest(session)
            uri.startsWith("/iclock/registry")   -> handleRegistry(session)
            uri.startsWith("/iclock/cdata")       -> handleCdata(session)
            else -> newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "NOT FOUND")
        }
    }

    private fun handleGetRequest(session: IHTTPSession): Response {
        Log.d(TAG, "📡 getrequest: ${session.parameters}")
        return okResponse()
    }

    private fun handleRegistry(session: IHTTPSession): Response {
        val body = readBody(session)
        Log.d(TAG, "📝 registry: $body")
        return okResponse()
    }

    private fun handleCdata(session: IHTTPSession): Response {
        val rawBody = readBody(session)
        Log.d(TAG, "📥 RAW ATTENDANCE DATA: $rawBody")

        val records = parseAttendance(rawBody)
        Log.d(TAG, "✅ PARSED RECORDS: $records")

        records.forEach { (userId, punchTime) ->
            cacheManager.processPunch(userId, punchTime)
        }

        return okResponse()
    }

    /**
     * Parses tab-delimited ZKTeco punch records.
     * Mirrors parseAttendance() in attendence.js.
     *
     * Format per line: PIN\tDateTime\tVerifyMode\tInOutMode\tWorkCode
     */
    private fun parseAttendance(raw: String?): List<Pair<String, String>> {
        if (raw.isNullOrBlank()) return emptyList()
        return raw.trim().lines()
            .filter { it.isNotBlank() }
            .mapNotNull { line ->
                val cols = line.split("\t")
                if (cols.size >= 2) Pair(cols[0], cols[1]) else null
            }
    }

    private fun readBody(session: IHTTPSession): String {
        return try {
            val contentLength = session.headers["content-length"]?.toIntOrNull() ?: 0
            if (contentLength > 0) {
                val buf = ByteArray(contentLength)
                session.inputStream.read(buf, 0, contentLength)
                String(buf, Charsets.UTF_8)
            } else ""
        } catch (e: Exception) {
            Log.e(TAG, "Body read error: ${e.message}")
            ""
        }
    }

    private fun okResponse() =
        newFixedLengthResponse(Response.Status.OK, MIME_PLAINTEXT, "OK")
}
```

---

## Phase 5 — Cache Flush Coroutine

Mirrors `setInterval(flushCache, BATCH_INTERVAL_MS)` with `BATCH_INTERVAL_MS = 1000` ms.

### 5.1 Repository — `AttendanceRepository.kt`

```kotlin
import kotlinx.coroutines.delay

class AttendanceRepository(
    private val dao: AttendanceDao,
    private val cacheManager: AttendanceCacheManager
) {
    /**
     * Runs forever, flushing cache to Room every 1 second.
     * Call from a coroutine launched in the Service scope.
     */
    suspend fun startFlushLoop() {
        while (true) {
            delay(1_000L)  // mirrors BATCH_INTERVAL_MS = 1000
            flush()
        }
    }

    private suspend fun flush() {
        val toFlush = cacheManager.drainForFlush()
        if (toFlush.isEmpty()) return

        var count = 0
        toFlush.forEach { (rfid, record) ->
            val entity = AttendanceEntity(
                date = record.date,
                rfid = rfid,
                intime = record.intime,
                outtime = record.outtime,
                isSynced = 0
            )
            val inserted = dao.insertIfNotExists(entity)
            if (inserted == -1L) {
                // Row already exists — update outtime
                dao.updateOuttime(rfid, record.date, record.outtime)
            }
            count++
        }

        if (count > 0) {
            android.util.Log.d("Repository", "💾 Flushed $count records to the database.")
        }
    }
}
```

---

## Phase 6 — Foreground Service

The service starts the NanoHTTPD server and the flush loop, keeping both alive while the app is backgrounded or the screen is off.

### 6.1 `AttendanceServerService.kt`

```kotlin
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*

class AttendanceServerService : Service() {

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private lateinit var admsServer: ZKTecoAdmsServer
    private lateinit var repository: AttendanceRepository

    override fun onCreate() {
        super.onCreate()
        startForeground(1, buildNotification())

        val db = AttendanceDatabase.getInstance(applicationContext)
        val cacheManager = AttendanceCacheManager(deviceUpdateTimeSec = 30)
        repository = AttendanceRepository(db.attendanceDao(), cacheManager)

        admsServer = ZKTecoAdmsServer(port = 3000, cacheManager = cacheManager)
        admsServer.start()
        Log.d("Service", "🟢 ZKTeco HTTP ADMS Server running on port 3000")

        // Start the 1-second flush loop
        serviceScope.launch {
            repository.startFlushLoop()
        }
    }

    override fun onDestroy() {
        admsServer.stop()
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val channelId = "attendance_server"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId, "Attendance Server", NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("Attendance Server")
            .setContentText("ZKTeco ADMS server running on port 3000")
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .build()
    }
}
```

---

## Phase 7 — Boot Receiver

Auto-start the server when the device reboots.

### 7.1 `BootReceiver.kt`

```kotlin
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val serviceIntent = Intent(context, AttendanceServerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        }
    }
}
```

---

## Phase 8 — Remote Sync (Optional)

Mirrors the `isSynced` flag and periodic sync pattern implied by `attendence.js`.

### 8.1 Retrofit API — `AttendanceApi.kt`

```kotlin
import retrofit2.http.Body
import retrofit2.http.POST

data class SyncPayload(val records: List<AttendanceEntity>)
data class SyncResponse(val success: Boolean)

interface AttendanceApi {
    @POST("/api/attendance/sync")
    suspend fun sync(@Body payload: SyncPayload): SyncResponse
}
```

### 8.2 SyncWorker — `SyncWorker.kt`

```kotlin
import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val db = AttendanceDatabase.getInstance(applicationContext)
        val dao = db.attendanceDao()

        val unsynced = dao.getUnsyncedRecords()
        if (unsynced.isEmpty()) return Result.success()

        return try {
            val api = RetrofitClient.instance.create(AttendanceApi::class.java)
            val response = api.sync(SyncPayload(unsynced))
            if (response.success) {
                dao.markAsSynced(unsynced.map { it.id })
            }
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    companion object {
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                "attendance_sync",
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }
    }
}
```

---

## Phase 9 — Suggested File / Package Structure

```
app/src/main/java/com/yourapp/attendance/
├── data/
│   ├── db/
│   │   ├── AttendanceDatabase.kt
│   │   ├── AttendanceDao.kt
│   │   └── AttendanceEntity.kt
│   ├── cache/
│   │   ├── AttendanceCacheManager.kt
│   │   └── CachedRecord.kt
│   └── repository/
│       └── AttendanceRepository.kt
├── network/
│   ├── ZKTecoAdmsServer.kt
│   ├── AttendanceApi.kt
│   └── RetrofitClient.kt
├── service/
│   └── AttendanceServerService.kt
├── worker/
│   └── SyncWorker.kt
└── receiver/
    └── BootReceiver.kt
```

---

## Phase 10 — ZKTeco Device Configuration

Configure your ZKTeco device to point at the Android phone/tablet:

| Setting          | Value                            |
|------------------|----------------------------------|
| Server Address   | `<Android device LAN IP>`        |
| Server Port      | `3000`                           |
| Protocol         | HTTP                             |
| Upload Interval  | 1–30 seconds                     |
| Path Prefix      | `/iclock`                        |

> **Tip:** Use a static IP or a DHCP reservation for the Android device on your local network to keep the ZKTeco device configuration stable.

---

## Implementation Checklist

- [ ] Phase 1 — Add Gradle dependencies and manifest permissions
- [ ] Phase 2 — Create Room entity, DAO, and database
- [ ] Phase 3 — Implement `AttendanceCacheManager` with punch + flush logic
- [ ] Phase 4 — Implement `ZKTecoAdmsServer` with NanoHTTPD
- [ ] Phase 5 — Implement `AttendanceRepository` with 1-second flush coroutine
- [ ] Phase 6 — Create `AttendanceServerService` foreground service
- [ ] Phase 7 — Create `BootReceiver` for auto-start on reboot
- [ ] Phase 8 — (Optional) Add `SyncWorker` for remote backend sync
- [ ] Phase 9 — Wire everything together in `Application.kt` or `MainActivity.kt`
- [ ] Phase 10 — Configure ZKTeco device to point at Android device IP:3000

---

## Key Mappings: `attendence.js` → Kotlin

| Node.js (`attendence.js`)             | Android Kotlin equivalent                        |
|---------------------------------------|--------------------------------------------------|
| `express` HTTP server on port 3000    | `NanoHTTPD` in `ZKTecoAdmsServer.kt`             |
| `/iclock/cdata` route                 | `handleCdata()` in `ZKTecoAdmsServer.kt`         |
| `parseAttendance()` tab-split         | `parseAttendance()` in `ZKTecoAdmsServer.kt`     |
| `userId.padStart(24, '0')`            | `userId.padStart(24, '0')` in `CacheManager`     |
| `attendanceCache` Map                 | `ConcurrentHashMap` in `AttendanceCacheManager`  |
| `DEVICE_UPDATE_TIME = 30`             | `deviceUpdateTimeSec = 30` constructor param     |
| `setInterval(flushCache, 1000)`       | `delay(1_000L)` loop in `startFlushLoop()`       |
| `db.run('PRAGMA journal_mode = WAL')` | `setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)`|
| `INSERT OR IGNORE`                    | `OnConflictStrategy.IGNORE` in Room DAO          |
| `isSynced` column                     | `isSynced` field in `AttendanceEntity`           |

; Web Keeper helper: press Right Arrow once per second to keep HLS loading.
; Requires AutoHotkey v2: https://www.autohotkey.com/
;
; F8  = start/stop (sends Right to the current window every 1s)
; Esc = stop
; Tip: focus the video tab/player first, then press F8.

#Requires AutoHotkey v2.0
#SingleInstance Force

intervalMs := 1000
enabled := false

F8::ToggleSeek()
Esc::StopSeek()

ToggleSeek() {
    global enabled
    if enabled {
        StopSeek()
    } else {
        enabled := true
        ToolTip "Web Keeper auto-seek: ON (Right every 1s)`nF8 stop / Esc stop"
        SetTimer SendRight, intervalMs
        SetTimer ClearTip, -1500
    }
}

StopSeek() {
    global enabled
    if !enabled
        return
    enabled := false
    SetTimer SendRight, 0
    ToolTip "Web Keeper auto-seek: OFF"
    SetTimer ClearTip, -1200
}

SendRight() {
    ; Send to the already-focused window (video tab / player).
    Send "{Right}"
}

ClearTip() {
    ToolTip
}

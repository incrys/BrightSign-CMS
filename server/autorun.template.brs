'==============================================================================
' BrightSign CMS - autorun.brs
' Player: {PLAYER_NAME} - Data: {GENERATED_DATE}
'==============================================================================

Sub Main()
    port           = CreateObject("roMessagePort")
    pollInterval   = 5000
    defaultImgTime = 10000
    playlistPath   = "cms_playlist.json"

    ' ── Loop esterno: ricarica playlist ad ogni cambio ──────────────────────
    Do
        raw = ReadAsciiFile(playlistPath)
        If raw = "" Then
            Sleep(pollInterval)
        Else
            playlist = ParseJSON(raw)
            If playlist = Invalid Or playlist.items = Invalid Or playlist.items.Count() = 0 Then
                Sleep(pollInterval)
            Else
                items     = playlist.items
                itemCount = items.Count()
                idx       = 0

                ' Poll timer
                pollTimer = CreateObject("roTimer")
                pollTimer.SetPort(port)
                pollTimer.SetDuration(pollInterval)
                pollTimer.Start()
                pollId = pollTimer.GetIdentity()

                ' Variabili player locali
                vp      = Invalid
                ip      = Invalid
                imgT    = Invalid
                changed = False

                ' Avvia primo item
                GoSub PlayCurrent

                ' ── Event loop ───────────────────────────────────────────────
                Do
                    msg     = Wait(0, port)
                    msgType = Type(msg)

                    If msgType = "roVideoEvent" Then
                        If msg.GetInt() = 8 Then
                            vp  = Invalid
                            idx = (idx + 1) Mod itemCount
                            GoSub PlayCurrent
                        End If

                    ElseIf msgType = "roTimerEvent" Then
                        If msg.GetSourceIdentity() = pollId Then
                            newRaw = ReadAsciiFile(playlistPath)
                            If newRaw <> "" And newRaw <> raw Then
                                changed = True
                            End If
                            If changed Then
                                pollTimer.Stop()
                                If vp <> Invalid Then vp.Stop() : vp = Invalid
                                ip   = Invalid
                                If imgT <> Invalid Then imgT.Stop() : imgT = Invalid
                                Exit Do
                            End If
                            pollTimer.Start()
                        Else
                            ' Timer immagine scaduto
                            ip   = Invalid
                            If imgT <> Invalid Then imgT.Stop() : imgT = Invalid
                            idx = (idx + 1) Mod itemCount
                            GoSub PlayCurrent
                        End If
                    End If
                Loop
            End If
        End If
    Loop

    ' ── GoSub: avvia item corrente ────────────────────────────────────────────
    PlayCurrent:
        ' Ferma player precedenti
        If vp <> Invalid Then vp.Stop() : vp = Invalid
        ip = Invalid
        If imgT <> Invalid Then imgT.Stop() : imgT = Invalid

        item     = items[idx]
        filePath = item.file
        ext      = LCase(Right(filePath, 4))
        isVideo  = (ext = ".mp4" Or ext = ".mov" Or ext = ".avi" Or ext = ".mkv" Or Right(filePath, 5) = ".mpeg")

        If isVideo Then
            vp = CreateObject("roVideoPlayer")
            vp.SetPort(port)
            vp.SetLoopMode(False)
            cl = CreateObject("roArray", 1, True)
            ci = CreateObject("roAssociativeArray")
            ci.ContentType = "video"
            ci.Url = filePath
            cl.Push(ci)
            vp.SetContentList(cl)
            vp.Play()
        Else
            ip = CreateObject("roImagePlayer")
            ip.SetPort(port)
            ip.DisplayFile(filePath)

            dur = defaultImgTime
            If item.duration <> Invalid Then dur = item.duration * 1000
            imgT = CreateObject("roTimer")
            imgT.SetPort(port)
            imgT.SetDuration(dur)
            imgT.Start()
        End If
    Return

End Sub

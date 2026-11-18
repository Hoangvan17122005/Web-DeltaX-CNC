Option Explicit

Dim shell, fileSystem, http, projectPath, nodePath, serverPath, command, status

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

projectPath = fileSystem.GetParentFolderName(WScript.ScriptFullName)
nodePath = "C:\Program Files\nodejs\node.exe"
serverPath = fileSystem.BuildPath(projectPath, "server.mjs")

On Error Resume Next
Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
http.Open "GET", "http://127.0.0.1:3000/api/health", False
http.Send
status = http.Status
On Error GoTo 0

If status = 200 Then WScript.Quit 0

If Not fileSystem.FileExists(nodePath) Then
  MsgBox "Không tìm thấy Node.js tại " & nodePath & ". Hãy cài Node.js hoặc cập nhật đường dẫn trong start-server-hidden.vbs.", vbExclamation, "FORGE CNC"
  WScript.Quit 1
End If

If Not fileSystem.FileExists(serverPath) Then
  MsgBox "Không tìm thấy server.mjs trong " & projectPath & ".", vbExclamation, "FORGE CNC"
  WScript.Quit 1
End If

shell.CurrentDirectory = projectPath
command = """" & nodePath & """ """ & serverPath & """"
shell.Run command, 0, False

"""Small local-only RCON client and parser for the server's SNBT result."""
import json
import re
import socket
import struct

class Rcon:
    def __init__(self,port,password):self.port=port;self.password=password;self.sock=None;self.ident=0
    def connect(self):
        self.sock=socket.create_connection(("127.0.0.1",self.port),timeout=15);self.sock.settimeout(15)
        self._send(3,self.password)
        ident,kind,text=self._receive()
        if ident==-1:raise RuntimeError("RCON authentication failed")
        if kind==0:ident,kind,text=self._receive()
        if ident==-1:raise RuntimeError("RCON authentication failed")
        return self
    def _read(self,n):
        value=b""
        while len(value)<n:
            block=self.sock.recv(n-len(value))
            if not block:raise ConnectionError("RCON closed")
            value+=block
        return value
    def _send(self,kind,text):
        self.ident+=1;body=struct.pack("<ii",self.ident,kind)+text.encode()+b"\0\0"
        self.sock.sendall(struct.pack("<i",len(body))+body)
    def _receive(self):
        size=struct.unpack("<i",self._read(4))[0]
        if not 10<=size<=1024*1024:raise RuntimeError("Invalid RCON response")
        body=self._read(size);ident,kind=struct.unpack("<ii",body[:8]);return ident,kind,body[8:-2].decode("utf-8")
    def command(self,text):
        self._send(2,text)
        while True:
            ident,kind,value=self._receive()
            if ident==self.ident:return value
    def close(self):
        if self.sock:self.sock.close()

def parse_snbt(text):
    tokens=re.findall(r'"(?:\\.|[^"\\])*"|\x27(?:\\.|[^\x27\\])*\x27|[{}\[\]:,]|[^\s{}\[\]:,]+',text)
    index=0
    def value():
        nonlocal index
        token=tokens[index];index+=1
        if token=="{":
            out={}
            while tokens[index]!="}":
                key=tokens[index];index+=1
                if tokens[index]!=":":raise ValueError("Invalid compound")
                index+=1;out[json.loads(key) if key.startswith('"') else key]=value()
                if tokens[index]==",":index+=1
                elif tokens[index]!="}":raise ValueError("Invalid compound separator")
            index+=1;return out
        if token=="[":
            out=[]
            while tokens[index]!="]":
                out.append(value())
                if tokens[index]==",":index+=1
                elif tokens[index]!="]":raise ValueError("Invalid list")
            index+=1;return out
        if token.startswith('"'):return json.loads(token)
        if token.startswith("'"):return token[1:-1]
        if re.fullmatch(r"[-+]?\d+[bBsSlL]?",token):return int(token.rstrip("bBsSlL"))
        if re.fullmatch(r"[-+]?\d+(?:\.\d+)?[fFdD]?",token):return float(token.rstrip("fFdD"))
        return token
    out=value()
    if index!=len(tokens):raise ValueError("Trailing SNBT data")
    return out

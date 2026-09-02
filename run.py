#!/usr/bin/env python3
"""Start the console.  python3 run.py  [--port 8000] [--data data]"""
import argparse
from tt.server import serve

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--data", default="data")
    a = ap.parse_args()
    serve(data_dir=a.data, host=a.host, port=a.port)

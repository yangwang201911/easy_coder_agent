#!/usr/bin/env bash
set -u

echo "== OS =="
grep PRETTY_NAME /etc/os-release
echo "kernel: $(uname -r)  arch: $(uname -m)"

echo "== GPU =="
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,pci.bus_id,memory.total,memory.free,utilization.gpu,driver_version --format=csv,noheader
  nvidia-smi --query-gpu=index,compute_cap --format=csv,noheader 2>/dev/null || true
  echo "driver CUDA ceiling: $(nvidia-smi | grep -o 'CUDA Version: [0-9.]*')"
else
  echo "nvidia-smi: not found"
fi
if command -v nvcc >/dev/null 2>&1; then
  echo "nvcc: $(nvcc --version | tail -1)"
else
  echo "nvcc: not found (not required for the ready-made engine)"
fi
if command -v lspci >/dev/null 2>&1; then
  echo "PCI display devices:"; lspci | grep -iE 'vga|3d controller' || true
fi

echo "== CPU =="
lscpu | grep -E 'Model name|^CPU\(s\)|Socket|NUMA node\(s\)'

echo "== RAM =="
grep -E 'MemTotal|MemAvailable' /proc/meminfo
[ -r /sys/fs/cgroup/memory.max ] && echo "cgroup memory.max: $(cat /sys/fs/cgroup/memory.max)"

echo "== Disk =="
lsblk -d -o NAME,ROTA,SIZE,TYPE
df -h --output=source,size,avail,target | grep -vE 'tmpfs|overlay|udev' || true

echo "== Strata =="
if command -v strata >/dev/null 2>&1; then strata --version; else echo "strata: not installed"; fi

echo "== Port 8080 =="
if ss -ltn 2>/dev/null | grep -q ':8080 '; then echo "8080: busy"; else echo "8080: free"; fi

echo "== Network =="
if curl -sI --max-time 10 https://github.com >/dev/null 2>&1; then echo "github.com: reachable"; else echo "github.com: unreachable (set proxy if needed)"; fi
if curl -sI --max-time 10 https://huggingface.co >/dev/null 2>&1; then echo "huggingface.co: reachable"; else echo "huggingface.co: unreachable (set proxy if needed)"; fi

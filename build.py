import os; os.chdir(os.path.dirname(os.path.abspath(__file__))); s=open('shell.html').read()
for k,f in [('CSS','style.css'),('SEARCH','search.js'),('TEST','testcards.js'),('APP','app.js')]:
    s=s.replace('/*'+k+'*/',open(f).read())
open('index.html','w').write(s)
print(len(s))

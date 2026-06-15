$fn=100;
module tube(id=19, od=23, h=40) {
    difference(){
        cylinder(d=od,h=h);
        translate([0,0,-1])
          cylinder(d=id,h=h+2);
        
    }
}
module tee(id=15.4, od=21, h=90) { 
    difference() {
        union() {
         tube(id=id,od=od, h=h);
            translate([0,0,h/2])
            rotate([0,90,0]) {
                tube(id=id,od=od, h=17);
                translate([0,0,17]) {
                tube(id=id,od=30, h=9.25, $fn=6);
                tube(id=17.8,od=25.6, h=21.9);
                }
            }
        }
        translate([0,0,-1])
          cylinder(d=id,h=h+2);
        translate([0,0,h/2])
            rotate([0,90,0]) {
              cylinder(d=id,h=h+2);
              translate([0,0,19])
                 cylinder(d=17.8,h=21.9);
         }
                

        
    }
    
    
}
module unc14Nut() {
    difference() {
    cylinder(d=12,h=5,$fn=6);
        translate([0,0,-1])
    cylinder(d=6,h=7);
    }
}
module mounting1() {
    difference() {
        union() {
            cylinder(d=15.4,h=20);
            translate([0,0,10])
            cylinder(d=17.8,h=12);
        }
    translate([0,0,0]) {
        translate([0,0,0])
            cylinder(d=9,h=25);
        translate([0,0,-1])
            cylinder(d=9.4,h=2);
        }
    }
}




module coil(d=7.4,h=8, turns=10, thick=0.2) {
    color("red")
    linear_extrude(height = h, twist = 360*turns, slices = 100, convexity = 20) {
            translate([d/2, 0, 0]) {
                circle(d=thick);
        }
    }
}

module heater2() {
    // 10 turn nicrome wire
    translate([0,0,1]) coil();
    tube(id=6, od=7, h=10);
    tube(id=7.5, od=9, h=10);
    tube(id=6, od=9, h=1);
    translate([0,0,10])
    tube(id=6, od=9, h=12);
}


module sensor() {
    difference(){
        union() {
            cylinder(d=6,h=35);
            cylinder(d=9.4,h=3.5);
        }
        translate([0,0,2])
        cylinder(d=3,h=40);
    }
}

module sensor2() {
    difference(){
        union() {
            cylinder(d=6,h=35);
        }
        translate([0,0,2])
        cylinder(d=3,h=40);
    }
}

module expanded() {
rotate([0,-90,0])
translate([0,0,-45])
tee();

translate([0,0,7])
sensor();

translate([0,0,65])
mounting1();

translate([0,0,105])
heater2();

translate([0,0,170])
unc14Nut();


    
}

module compact() {
//rotate([0,-90,0])
//translate([0,0,-45])
//tee();

translate([0,0,8])
{
translate([0,0,0])
sensor();

translate([0,0,3])
mounting1();

translate([0,0,4])
heater2();

translate([0,0,30])
unc14Nut();
}


    
}

difference() {
    compact();
    cube([50,50,100]);
}
//rotate([0,-90,0])
//translate([0,0,-20])
//tee(id=19, od=23, h=40);
/*
translate([0,0,7])
sensor();

//translate([0,0,10])
//mounting1();
//translate([0,0,16])
//mounting2();


//translate([0,0,26])
//heaterHousing();

//translate([-60,0,26])
//heater();

translate([0,0,30])
unc14Nut();

heater2();
*/
